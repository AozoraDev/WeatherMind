"use client"

import { useCallback, useRef, useState } from "react"

import type { ForecastAgentPhase } from "@/lib/forecast-agent/stream/stream"
import type { ForecastAgentStreamEvent } from "@/lib/forecast-agent/stream/stream"
import type { ForecastAgentErrorCode } from "@/lib/forecast-agent/common/errors"
import type { ForecastDbRow } from "@/lib/schemas/forecast-agent"
import type { ModelConfig } from "@/lib/model-config"
import { useSseStream } from "@/hooks/use-sse-stream"

// 前端消费 /api/ai-agent/forecast 的 SSE 流。传输层（fetch/getReader/逐帧解析/错误码映射）
// 收敛在 useSseStream，这里只做「事件 → 内容 state」的分发：delta 逐字追加 markdown、
// thought 开新推理步、tool 实时归入当前步、rollback 把工具步的思考文字从 markdown 尾部回滚、
// agent_start 开时间线分组（agent_end 仅作边界、不渲染）。done 后以服务端回读行 react_trace 为准。
// 多 agent 编排后事件统一带 agentId，前端据此把轨迹按 agent 分组渲染时间线。
// 这是 rules/fetch-usage.md「客户端不裸 fetch」的受控例外（真流式 TanStack Query 无法承载）。

export type ForecastStreamStatus = "idle" | "streaming" | "done" | "error"

// 时间线轨迹步：thought + actions（args 可能字符串或对象——DB 兜底），agent_id 标记所属 agent
export type TimelineStep = {
  thought: string | null
  actions: { name: string; args: string | Record<string, unknown>; result: string }[]
}
// 分组后的时间线：同一 agent 的轨迹步一组，组间按启动序保序；旧行无 agent 标记归 "" 单组
export type TimelineGroup = { agentId: string; steps: TimelineStep[] }

// 按相邻 agent_id 分组保序（无 agent_id 的旧行归入 agentId:"" 单组）。hook 与推理卡共用
export function groupByAgent(
  trace: { thought: string | null; actions: TimelineStep["actions"]; agent_id?: string | null }[]
): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let current: TimelineGroup | null = null
  for (const step of trace) {
    const id = step.agent_id ?? ""
    if (!current || current.agentId !== id) {
      current = { agentId: id, steps: [] }
      groups.push(current)
    }
    current.steps.push({ thought: step.thought, actions: step.actions })
  }
  return groups
}

// 开组：某 agent 首次出现才建（时间线按启动序保序）；重复 agent_start 幂等
function ensureGroup(
  agents: TimelineGroup[],
  agentId: string
): TimelineGroup[] {
  if (agents.some((g) => g.agentId === agentId)) return agents
  return [...agents, { agentId, steps: [] }]
}

// 往某 agent 组追加轨迹步（thought 事件开新步）
function appendStep(
  agents: TimelineGroup[],
  agentId: string,
  step: TimelineStep
): TimelineGroup[] {
  return ensureGroup(agents, agentId).map((g) =>
    g.agentId === agentId ? { ...g, steps: [...g.steps, step] } : g
  )
}

// 往某 agent 组当前步追加工具动作（tool 事件）；该 agent 尚无步时兜底开一步
function appendAction(
  agents: TimelineGroup[],
  agentId: string,
  action: TimelineStep["actions"][number]
): TimelineGroup[] {
  return ensureGroup(agents, agentId).map((g) => {
    if (g.agentId !== agentId) return g
    const steps = [...g.steps]
    const last = steps[steps.length - 1]
    if (last) {
      steps[steps.length - 1] = { ...last, actions: [...last.actions, action] }
    } else {
      steps.push({ thought: null, actions: [action] })
    }
    return { ...g, steps }
  })
}

export type ForecastStreamState = {
  status: ForecastStreamStatus
  phase: ForecastAgentPhase | null
  markdown: string // 已流式累积的 Markdown 全文（含最终落库后的完整正文）
  row: ForecastDbRow | null // duplicate/done 后服务端回读的行
  errorCode: ForecastAgentErrorCode | null
  agents: TimelineGroup[] // 流式期实时累积的分组时间线；done 后以 row.react_trace 为准
}

type UseForecastStreamArgs = {
  cityId: string
  locale: "zh" | "en"
  model: ModelConfig | null // null = 未配置模型，start 直接报 no-model
  onDone?: (row: ForecastDbRow) => void
  onError?: (code: ForecastAgentErrorCode) => void
}

// 内容态（markdown/phase/row/agents）与传输层状态（status/errorCode）分开存放：
// onEvent 只更新内容态，终态由 ctx.markDone / ctx.fail 驱动
type ForecastContent = {
  phase: ForecastAgentPhase | null
  markdown: string
  row: ForecastDbRow | null
  agents: TimelineGroup[]
}

const IDLE_CONTENT: ForecastContent = {
  phase: null,
  markdown: "",
  row: null,
  agents: [],
}

export function useForecastStream({
  cityId,
  locale,
  model,
  onDone,
  onError,
}: UseForecastStreamArgs) {
  const [content, setContent] = useState<ForecastContent>(IDLE_CONTENT)
  const mdRef = useRef("")

  const sse = useSseStream<
    undefined,
    ForecastAgentErrorCode,
    ForecastAgentStreamEvent
  >({
    url: "/api/ai-agent/forecast",
    model,
    buildBody: () => ({ cityId, locale }),
    onTransportError: "provider",
    onNoBodyError: "provider",
    onParseError: "parse",
    decodeError: (e) => (e === "no-model" ? "no-model" : "generic"),
    onEvent: (ev, ctx) => {
      switch (ev.type) {
        case "status":
          setContent((s) => ({ ...s, phase: ev.phase }))
          break
        case "delta":
          mdRef.current += ev.text
          setContent((s) => ({ ...s, markdown: mdRef.current }))
          break
        case "duplicate":
        case "done": {
          const row = ev.row
          // done 后轨迹以服务端回读行 react_trace 为准，清空流式期累积的分组（重新按 agent 分组）
          const md = row.markdown_body ?? mdRef.current
          mdRef.current = md
          setContent({
            phase: null,
            markdown: md,
            row,
            agents: groupByAgent(row.react_trace ?? []),
          })
          ctx.markDone()
          onDone?.(row)
          break
        }
        case "agent_start":
          // 开时间线分组：某 agent 首次出现才建（顺序 = 启动序）；重复 start 幂等
          setContent((s) => ({ ...s, agents: ensureGroup(s.agents, ev.agentId) }))
          break
        case "agent_end":
          // 边界事件：不渲染（仅 agent_start 已开组），留作前端可选的回调钩子
          break
        case "thought":
          // 工具步边界 + 思考文字：往所属 agent 组开新步，后续 tool 事件归入该步
          setContent((s) => ({
            ...s,
            agents: appendStep(s.agents, ev.agentId, {
              thought: ev.text,
              actions: [],
            }),
          }))
          break
        case "rollback":
          // 思考文字已按 delta 累积进 markdown，从尾部回滚（不属于最终答案正文）
          mdRef.current = mdRef.current.slice(
            0,
            Math.max(0, mdRef.current.length - ev.chars)
          )
          setContent((s) => ({ ...s, markdown: mdRef.current }))
          break
        case "tool":
          // 归入所属 agent 组当前步（thought 事件已先开步）；该 agent 尚无步时兜底开一步
          setContent((s) => ({
            ...s,
            agents: appendAction(s.agents, ev.agentId, {
              name: ev.name,
              args: ev.args,
              result: ev.result,
            }),
          }))
          break
        case "error":
          ctx.fail(ev.code)
          break
      }
    },
    onReset: () => {
      mdRef.current = ""
      setContent(IDLE_CONTENT)
    },
    onError,
  })

  // 本 hook 的 start 无参，包一层兼容 useSseStream 的 start(params)。
  // 先解构再进 deps：sse 对象每次渲染都是新引用，直接依赖 sse 会让 start 每次渲染重建
  const sseStart = sse.start
  const start = useCallback(() => sseStart(undefined), [sseStart])

  return {
    state: {
      status: sse.status,
      ...content,
      errorCode: sse.errorCode,
    },
    start,
    cancel: sse.cancel,
    reset: sse.reset,
  }
}
