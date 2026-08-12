import type { ChatUsage } from "@/lib/schemas/agent-core"

import type { ChatMessage, ProviderErrorCode } from "./chat"
import {
  mergeUsage,
  type ReactLoopResult,
  type ReactTrace,
  type ReactTool,
  type ReactTraceStep,
} from "./react"
import { runReActLoopStream } from "./react-stream"

// —— 通用主管+专家编排层 ——
// runSupervisedStream：主管一个 ReAct 循环 + 多个专家各自 ReAct 循环的顺序委托编排。
// 每个专家被包装成一个「delegate 工具」注入主管的工具列表；主管调 delegate 即触发该专家
// 完整执行，观察结果（专家最终内容）返回给主管继续推理——复刻已有「工具即 agent」委托模式
// （主 Agent 的 generate_forecast 委托 ForecastAgent）。
// 所有事件统一打 agentId 透传（agent_start/thought/tool/agent_end），前端据此渲染多 agent 时间线；
// 只有主管（输出 agent）的 delta/rollback 对外发出——专家最终内容以主管的 delegate 观察呈现，
// 不污染最终 Markdown。轨迹扁平化按事件发生的先后顺序（全局时间序），每步带所属 agent_id。

export type AgentId = string

// 扁平化轨迹步：每步带所属 agent（落库/前端分组用）
export type AgentTraceStep = ReactTraceStep & { agent_id: AgentId }

// 专家：编排层只负责「执行 + 事件路由」，提示词/工具/描述由调用方按领域提供
export type SpecialistAgent<TCtx> = {
  agentId: AgentId
  // delegate 工具描述（本地化由调用方负责：en 模式必须英文，否则模型会被中文工具文档带偏）
  toolDescription: (ctx: TCtx) => string
  buildMessages: (ctx: TCtx) => ChatMessage[]
  buildTools: (ctx: TCtx) => ReactTool[]
  maxSteps?: number // 默认 2
  timeoutMs?: number // 默认 45_000
}

// 主管：buildTools 收到编排层构造好的 delegate 工具，可再追加自己的工具
export type SupervisorConfig<TCtx> = {
  agentId: AgentId
  buildMessages: (ctx: TCtx) => ChatMessage[]
  buildTools: (ctx: TCtx, delegateTools: ReactTool[]) => ReactTool[]
  maxSteps?: number // 默认 4
  timeoutMs?: number // 默认 45_000
}

export type OrchestratorStreamEvent =
  | { type: "agent_start"; agentId: AgentId }
  | { type: "agent_end"; agentId: AgentId; ok: boolean }
  | { type: "delta"; agentId: AgentId; text: string }
  | { type: "thought"; agentId: AgentId; text: string }
  | { type: "rollback"; agentId: AgentId; chars: number }
  | { type: "tool"; agentId: AgentId; name: string; args: string; result: string }
  | { type: "result"; result: OrchestratorResult }

export type OrchestratorResult =
  | {
      ok: true
      content: string
      usage: ChatUsage | null
      trace: AgentTraceStep[]
    }
  | { ok: false; error: ProviderErrorCode | "react-loop" }

export type OrchestratorParams<TCtx> = {
  model: { baseUrl: string; apiKey: string; model: string }
  ctx: TCtx
  supervisor: SupervisorConfig<TCtx>
  specialists: SpecialistAgent<TCtx>[]
  // 进度回调（每步轨迹落库用）；异常吞掉，不中止编排
  onTrace?: (trace: AgentTraceStep[]) => void | Promise<void>
  // 外部取消信号（客户端断开）：透传给主管与专家各自的 ReAct 循环，
  // 断线前已发起的委托其 LLM 调用也会被中断（channel.closed 只停推事件，不停在途调用）
  signal?: AbortSignal
}

// 同步 push 的异步事件队列：push 有等待的 next 直接 resolve，否则入 buffer；
// closed 后 push 丢弃（no-op），end() 幂等。主管任务与生成器「泵」通过它解耦——
// 否则生成器卡在主管循环的 for await 上时，读不到专家经 delegate 灌入的事件
type ChannelFrame<T> = { done: true } | { done: false; value: T }
type Channel<T> = AsyncGenerator<T> & {
  push: (value: T) => void
  end: () => void
  closed: boolean
}

function createChannel<T>(): Channel<T> {
  const buffer: T[] = []
  const waiters: Array<(frame: ChannelFrame<T>) => void> = []

  const next = (): Promise<ChannelFrame<T>> => {
    const value = buffer.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (channel.closed) return Promise.resolve({ done: true })
    return new Promise((resolve) => waiters.push(resolve))
  }

  const gen = (async function* () {
    while (true) {
      const frame = await next()
      if (frame.done) return
      yield frame.value
    }
  })()

  const channel = Object.assign(gen, {
    push: (value: T) => {
      if (channel.closed) return
      const waiter = waiters.shift()
      if (waiter) waiter({ done: false, value })
      else buffer.push(value)
    },
    end: () => {
      if (channel.closed) return
      channel.closed = true
      while (waiters.length) waiters.shift()!({ done: true })
    },
    closed: false,
  })
  return channel
}

export async function* runSupervisedStream<TCtx>(
  params: OrchestratorParams<TCtx>
): AsyncGenerator<OrchestratorStreamEvent> {
  const { model, ctx, supervisor, specialists, onTrace, signal } = params
  const channel = createChannel<OrchestratorStreamEvent>()

  // 全局时间序轨迹：事件先到先记（专家步在主管对应 delegate 工具步完成前就已发生），
  // 与前端流式时间线一致；每步带所属 agent
  const globalTrace: AgentTraceStep[] = []
  const stepCountByAgent = new Map<AgentId, number>()
  let totalUsage: ChatUsage | null = null

  // 每 agent 的 onTrace：把新增步按序追加进全局轨迹，并透传外层进度回调（异常吞掉）
  const makeAgentOnTrace =
    (agentId: AgentId) =>
    async (trace: ReactTrace): Promise<void> => {
      const prev = stepCountByAgent.get(agentId) ?? 0
      for (const step of trace.slice(prev)) {
        globalTrace.push({ ...step, agent_id: agentId })
      }
      stepCountByAgent.set(agentId, trace.length)
      if (onTrace) {
        try {
          await onTrace(globalTrace)
        } catch {
          // 进度写失败仅丢失实时轨迹，不中止编排
        }
      }
    }

  // 委托工具：把专家包装成无参工具，execute 内跑该专家的完整 ReAct 循环。
  // 专家事件（agent_start/thought/tool/agent_end）灌入 channel；delta/rollback 丢弃
  // （专家最终内容以返回值成为主管的 delegate 观察，不污染全局 Markdown 文档）
  const makeDelegateTool = (spec: SpecialistAgent<TCtx>): ReactTool => ({
    name: `delegate_${spec.agentId}`,
    description: spec.toolDescription(ctx),
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      channel.push({ type: "agent_start", agentId: spec.agentId })
      let loopResult: ReactLoopResult | null = null
      try {
        for await (const ev of runReActLoopStream({
          model,
          messages: spec.buildMessages(ctx),
          tools: spec.buildTools(ctx),
          maxSteps: spec.maxSteps ?? 2,
          timeoutMs: spec.timeoutMs ?? 45_000,
          onTrace: makeAgentOnTrace(spec.agentId),
          signal,
        })) {
          if (channel.closed) break
          if (ev.type === "thought") {
            channel.push({
              type: "thought",
              agentId: spec.agentId,
              text: ev.text,
            })
          } else if (ev.type === "tool") {
            channel.push({
              type: "tool",
              agentId: spec.agentId,
              name: ev.name,
              args: ev.args,
              result: ev.result,
            })
          } else if (ev.type === "result") {
            loopResult = ev.result
            break
          }
        }
      } finally {
        channel.push({
          type: "agent_end",
          agentId: spec.agentId,
          ok: !!loopResult?.ok,
        })
      }
      if (loopResult?.ok) {
        if (loopResult.usage) totalUsage = mergeUsage(totalUsage, loopResult.usage)
        return loopResult.content
      }
      return JSON.stringify({ error: loopResult?.error ?? "react-loop" })
    },
  })

  // 主管任务：独立异步任务灌 channel，生成器只做「泵」——逐个取事件给调用方。
  // 任务体全包 try/catch/finally，保证断线/异常后无未处理 rejection
  const task = (async () => {
    try {
      channel.push({ type: "agent_start", agentId: supervisor.agentId })
      const delegateTools = specialists.map(makeDelegateTool)
      const tools = supervisor.buildTools(ctx, delegateTools)
      let result: ReactLoopResult | null = null
      for await (const ev of runReActLoopStream({
        model,
        messages: supervisor.buildMessages(ctx),
        tools,
        maxSteps: supervisor.maxSteps ?? 4,
        timeoutMs: supervisor.timeoutMs ?? 45_000,
        onTrace: makeAgentOnTrace(supervisor.agentId),
        signal,
      })) {
        if (channel.closed) break
        if (ev.type === "delta") {
          channel.push({ type: "delta", agentId: supervisor.agentId, text: ev.text })
        } else if (ev.type === "thought") {
          channel.push({
            type: "thought",
            agentId: supervisor.agentId,
            text: ev.text,
          })
        } else if (ev.type === "rollback") {
          channel.push({
            type: "rollback",
            agentId: supervisor.agentId,
            chars: ev.chars,
          })
        } else if (ev.type === "tool") {
          channel.push({
            type: "tool",
            agentId: supervisor.agentId,
            name: ev.name,
            args: ev.args,
            result: ev.result,
          })
        } else if (ev.type === "result") {
          result = ev.result
          break
        }
      }
      channel.push({
        type: "agent_end",
        agentId: supervisor.agentId,
        ok: !!result?.ok,
      })
      if (result?.ok) {
        if (result.usage) totalUsage = mergeUsage(totalUsage, result.usage)
        channel.push({
          type: "result",
          result: {
            ok: true,
            content: result.content,
            usage: totalUsage,
            trace: globalTrace,
          },
        })
      } else {
        channel.push({
          type: "result",
          result: { ok: false, error: result?.error ?? "react-loop" },
        })
      }
    } catch {
      // 未预期异常：兜底为 react-loop 结束（channel 清理统一交 finally）
      channel.push({
        type: "result",
        result: { ok: false, error: "react-loop" },
      })
    } finally {
      channel.end()
    }
  })()

  try {
    // 泵：逐事件 yield 给调用方；主管任务 push 的 result 送达后 channel 结束
    yield* channel
    await task
  } finally {
    // 断线/中途 break：置 closed，主管任务的后续 push 被丢弃、下一帧检查 closed 提前退出
    channel.end()
  }
}
