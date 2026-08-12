import { describe, expect, it, vi } from "vitest"

import type { ChatMessage, ProviderErrorCode } from "./chat"
import type { ReactTool, ReactTrace } from "./react"
import { runReActLoopStream, type ReActLoopStreamEvent } from "./react-stream"
import {
  runSupervisedStream,
  type OrchestratorStreamEvent,
  type SpecialistAgent,
  type SupervisorConfig,
} from "./orchestrator"

// —— 通用主管+专家编排层测试 ——
// 不真调 LLM：mock 掉 runReActLoopStream，按调用方 tools 分流模拟不同 agent 的循环事件
// （含 delegate_ 前缀 → 主管；含 query_source → 源核对专家；无工具 → 风险专家），
// 从而驱动 delegate 工具真的执行、验证事件路由/轨迹/usage 的编排逻辑

vi.mock("./react-stream", () => ({
  runReActLoopStream: vi.fn(),
}))

// mock 循环的参数：与真实 runReActLoopStream 形参同形，保证 mockImplementation 类型可赋值
type LoopParams = {
  model: { baseUrl: string; apiKey: string; model: string }
  messages: ChatMessage[]
  tools: ReactTool[]
  timeoutMs?: number
  maxSteps?: number
  onTrace?: (trace: ReactTrace) => void | Promise<void>
  signal?: AbortSignal
}

const SUPERVISOR_USAGE = {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
}
const RECONCILE_USAGE = {
  prompt_tokens: 20,
  completion_tokens: 10,
  total_tokens: 30,
}
const RISK_USAGE = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }

type TestCtx = { city: string }
const ctx: TestCtx = { city: "Tokyo" }
const model = { baseUrl: "https://api.example.com", apiKey: "k", model: "gpt-x" }

const reconcile: SpecialistAgent<TestCtx> = {
  agentId: "reconcile",
  toolDescription: (c) => `委托源核对专家（${c.city}）`,
  buildMessages: () => [{ role: "system", content: "reconcile" }],
  buildTools: () => [
    { name: "query_source", description: "q", parameters: {}, execute: () => "{}" },
  ],
  maxSteps: 3,
}
const risk: SpecialistAgent<TestCtx> = {
  agentId: "risk",
  toolDescription: () => "委托风险解读专家",
  buildMessages: () => [{ role: "system", content: "risk" }],
  buildTools: () => [],
}
const supervisor: SupervisorConfig<TestCtx> = {
  agentId: "supervisor",
  buildMessages: () => [{ role: "system", content: "supervisor" }],
  buildTools: (_ctx, delegateTools) => delegateTools,
}

// 源核对专家循环：思考 + query_source 工具步 + 最终 delta/result。
// 特意模拟真实 runReActLoopStream 的流式语义：工具步思考文字先按 delta 透传再 rollback、
// 最终内容按 delta 流式——用来断言编排层把这些 delta/rollback 丢弃（不污染主管文档）
async function* reconcileLoop(
  params: LoopParams
): AsyncGenerator<ReActLoopStreamEvent> {
  yield { type: "thought", text: "核对分歧源" }
  const obs = JSON.stringify({ source: "open-meteo", precip: 0 })
  yield { type: "tool", name: "query_source", args: "{}", result: obs }
  await params.onTrace?.([
    { thought: "核对分歧源", actions: [{ name: "query_source", args: "{}", result: obs }] },
  ])
  yield { type: "delta", text: "核对结论：各源一致" }
  yield { type: "rollback", chars: 9 }
  yield {
    type: "result",
    result: { ok: true, content: "核对结论：各源一致", usage: RECONCILE_USAGE, trace: [] },
  }
}

// 风险专家循环：无工具，一步直出
async function* riskLoop(): AsyncGenerator<ReActLoopStreamEvent> {
  yield { type: "delta", text: "风险解读：无风险" }
  yield {
    type: "result",
    result: { ok: true, content: "风险解读：无风险", usage: RISK_USAGE, trace: [] },
  }
}

// 主管循环：可配置是否调 delegate、最终内容、是否失败。
// 工具步按真实 executeToolCalls 语义模拟：先逐个执行 delegate（专家事件灌入 channel），
// 全部执行完才逐个 yield tool 事件、再触发 onTrace
function supervisorLoop(opts: {
  delegateCalls?: ("reconcile" | "risk")[]
  finalContent?: string
  failWith?: ProviderErrorCode | "react-loop"
}) {
  return async function* (
    params: LoopParams
  ): AsyncGenerator<ReActLoopStreamEvent> {
    if (opts.delegateCalls?.length) {
      yield { type: "thought", text: "委托专家" }
      yield { type: "rollback", chars: 4 }
      const actions: { name: string; args: string; result: string }[] = []
      for (const id of opts.delegateCalls) {
        const tool = params.tools.find((t) => t.name === `delegate_${id}`)!
        const obs = await tool.execute({})
        actions.push({ name: `delegate_${id}`, args: "{}", result: obs })
      }
      for (const a of actions)
        yield { type: "tool", name: a.name, args: a.args, result: a.result }
      await params.onTrace?.([{ thought: "委托专家", actions }])
    }
    if (opts.failWith) {
      yield { type: "result", result: { ok: false, error: opts.failWith } }
      return
    }
    yield { type: "delta", text: opts.finalContent ?? "final" }
    yield {
      type: "result",
      result: {
        ok: true,
        content: opts.finalContent ?? "final",
        usage: SUPERVISOR_USAGE,
        trace: [],
      },
    }
  }
}

function setLoopMock(
  impl: (params: LoopParams) => AsyncGenerator<ReActLoopStreamEvent>
): typeof runReActLoopStream {
  const mock = vi.mocked(runReActLoopStream)
  mock.mockImplementation(async function* (
    params: LoopParams
  ): AsyncGenerator<ReActLoopStreamEvent> {
    const names = params.tools.map((t) => t.name)
    if (names.some((n) => n.startsWith("delegate_"))) return yield* impl(params)
    if (names.includes("query_source")) return yield* reconcileLoop(params)
    return yield* riskLoop()
  })
  return mock
}

async function consume(gen: AsyncGenerator<OrchestratorStreamEvent>) {
  const events: OrchestratorStreamEvent[] = []
  for await (const ev of gen) events.push(ev)
  return events
}

describe("runSupervisedStream", () => {
  it("主管一步直出（不调 delegate）→ 仅主管事件，轨迹为空", async () => {
    setLoopMock(supervisorLoop({ finalContent: "final" }))
    const events = await consume(
      runSupervisedStream({
        model,
        ctx,
        supervisor,
        specialists: [reconcile, risk],
      })
    )
    expect(events).toEqual([
      { type: "agent_start", agentId: "supervisor" },
      { type: "delta", agentId: "supervisor", text: "final" },
      { type: "agent_end", agentId: "supervisor", ok: true },
      {
        type: "result",
        result: {
          ok: true,
          content: "final",
          usage: SUPERVISOR_USAGE,
          trace: [],
        },
      },
    ])
  })

  it("主管调两个 delegate → 事件按序透传，专家 delta/rollback 被丢弃，观察进主管 tool", async () => {
    setLoopMock(supervisorLoop({ delegateCalls: ["reconcile", "risk"], finalContent: "final" }))
    const events = await consume(
      runSupervisedStream({
        model,
        ctx,
        supervisor,
        specialists: [reconcile, risk],
      })
    )
    // 关键顺序断言：专家事件（agent_start/thought/tool/agent_end）先于主管对应 delegate 的 tool 事件
    expect(events.map((e) => e.type)).toEqual([
      "agent_start",
      "thought",
      "rollback",
      "agent_start",
      "thought",
      "tool",
      "agent_end",
      "agent_start",
      "agent_end",
      "tool",
      "tool",
      "delta",
      "agent_end",
      "result",
    ])
    // 各事件携带正确 agentId（同类型取第一个：agent_start/thought 有多个，首条都是主管的）
    expect(events.find((e) => e.type === "agent_start")).toMatchObject({
      agentId: "supervisor",
    })
    expect(events.find((e) => e.type === "thought")).toMatchObject({
      agentId: "supervisor",
    })
    expect(events.find((e) => e.type === "rollback")).toMatchObject({
      agentId: "supervisor",
    })
    // 专家 delta/rollback 被丢弃：reconcile 的 delta/rollback 不应出现
    const deltas = events.filter((e) => e.type === "delta")
    expect(deltas).toEqual([{ type: "delta", agentId: "supervisor", text: "final" }])
    // 主管 delegate 工具的观察 = 专家最终内容（reconcile 的 query_source 工具事件已单独透传，此处只看主管的）
    const tools = events.filter(
      (e): e is { type: "tool"; agentId: string; name: string; args: string; result: string } =>
        e.type === "tool" && e.agentId === "supervisor"
    )
    expect(tools).toEqual([
      { type: "tool", agentId: "supervisor", name: "delegate_reconcile", args: "{}", result: "核对结论：各源一致" },
      { type: "tool", agentId: "supervisor", name: "delegate_risk", args: "{}", result: "风险解读：无风险" },
    ])
    // usage 跨 agent 聚合
    const result = events[events.length - 1]
    if (result.type !== "result" || !result.result.ok) throw new Error("should be ok")
    expect(result.result.usage).toEqual({
      prompt_tokens: 125,
      completion_tokens: 65,
      total_tokens: 190,
    })
  })

  it("专家失败 → agent_end ok:false，观察为 error JSON，主管仍可继续", async () => {
    // 源核对专家循环返回失败（其余分流不变）
    vi.mocked(runReActLoopStream).mockImplementation(async function* (
      params: LoopParams
    ) {
      const names = params.tools.map((t) => t.name)
      if (names.some((n) => n.startsWith("delegate_")))
        return yield* supervisorLoop({
          delegateCalls: ["reconcile", "risk"],
          finalContent: "final",
        })(params)
      if (names.includes("query_source")) {
        yield { type: "result", result: { ok: false, error: "network" } }
        return
      }
      return yield* riskLoop()
    })
    const events = await consume(
      runSupervisedStream({
        model,
        ctx,
        supervisor,
        specialists: [reconcile, risk],
      })
    )
    // reconcile 的 agent_end 为失败；主管仍收到观察并产出终稿
    const ends = events.filter((e) => e.type === "agent_end")
    expect(ends).toEqual([
      { type: "agent_end", agentId: "reconcile", ok: false },
      { type: "agent_end", agentId: "risk", ok: true },
      { type: "agent_end", agentId: "supervisor", ok: true },
    ])
    const reconcileTool = events.find(
      (e) => e.type === "tool" && e.name === "delegate_reconcile"
    )
    expect(reconcileTool).toMatchObject({ result: '{"error":"network"}' })
    const last = events[events.length - 1]
    expect(last.type).toBe("result")
  })

  it("主管循环失败 → 错误码透传", async () => {
    setLoopMock(supervisorLoop({ failWith: "react-loop" }))
    const events = await consume(
      runSupervisedStream({ model, ctx, supervisor, specialists: [reconcile, risk] })
    )
    expect(events[events.length - 1]).toEqual({
      type: "result",
      result: { ok: false, error: "react-loop" },
    })
  })

  it("轨迹按 onTrace 触发序扁平化并带 agent_id", async () => {
    setLoopMock(supervisorLoop({ delegateCalls: ["reconcile"], finalContent: "final" }))
    const traces: unknown[] = []
    await consume(
      runSupervisedStream({
        model,
        ctx,
        supervisor,
        specialists: [reconcile, risk],
        onTrace: (trace) => {
          traces.push(trace)
        },
      })
    )
    // 最后一次进度回调即最终全局轨迹：reconcile 步先完成（专家循环内 onTrace），supervisor 步后完成
    const final = traces[traces.length - 1] as {
      thought: string | null
      agent_id: string
    }[]
    expect(final.map((s) => s.agent_id)).toEqual(["reconcile", "supervisor"])
    expect(final[0].thought).toBe("核对分歧源")
    expect(final[1].thought).toBe("委托专家")
    // result.trace 与最终进度一致
    const events = await consume(
      runSupervisedStream({ model, ctx, supervisor, specialists: [reconcile, risk] })
    )
    const result = events[events.length - 1]
    if (result.type !== "result" || !result.result.ok) throw new Error("should be ok")
    expect(result.result.trace.map((s) => s.agent_id)).toEqual([
      "reconcile",
      "supervisor",
    ])
  })

  it("断线（gen.return()）后收敛无悬挂", async () => {
    setLoopMock(supervisorLoop({ delegateCalls: ["reconcile", "risk"], finalContent: "final" }))
    const gen = runSupervisedStream({
      model,
      ctx,
      supervisor,
      specialists: [reconcile, risk],
    })
    // 消费一个事件后中断：return() 应正常完成，不抛错、不悬挂
    const first = await gen.next()
    expect(first.done).toBe(false)
    await gen.return(undefined)
  })

  it("不传 onTrace 也能跑通（进度回调可省）", async () => {
    setLoopMock(supervisorLoop({ delegateCalls: ["reconcile"], finalContent: "final" }))
    const events = await consume(
      runSupervisedStream({ model, ctx, supervisor, specialists: [reconcile, risk] })
    )
    expect(events[events.length - 1].type).toBe("result")
  })

  it("signal 透传给主管与专家的 runReActLoopStream（断线取消在途委托）", async () => {
    setLoopMock(
      supervisorLoop({ delegateCalls: ["reconcile"], finalContent: "final" })
    )
    const controller = new AbortController()
    // 该文件无 beforeEach 清 mock，calls 跨用例累计；只取本次用例新增的调用
    const prevCalls = vi.mocked(runReActLoopStream).mock.calls.length
    await consume(
      runSupervisedStream({
        model,
        ctx,
        supervisor,
        specialists: [reconcile, risk],
        signal: controller.signal,
      })
    )
    const calls = vi
      .mocked(runReActLoopStream)
      .mock.calls.slice(prevCalls)
    // 主管 + 被委托的 reconcile 专家各一次；所有循环都拿到同一个取消信号
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const [params] of calls) expect(params.signal).toBe(controller.signal)
  })
})
