"use client"

import { useLayoutEffect, useRef, type ReactNode } from "react"

import { Wrench } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ForecastDbRow } from "@/lib/schemas/forecast-agent"
import {
  groupByAgent,
  type ForecastStreamState,
  type TimelineGroup,
} from "@/hooks/use-forecast-stream"

import { ForecastCardShell } from "@/components/ui-preset/forecast-card-shell"

// AI 推理过程卡片：展示多 agent 时间线（每位 agent 的 ReAct 思考文字 + 工具调用轨迹），流式实时出现。
// 与 ForecastAgentCard 共用同一流状态：本卡管「各 agent 思考与工具调用过程」，那张卡管 AI 的 Markdown 正文。
// 多 agent 编排后 SSE 事件带 agentId：agent_start 开组、thought/tool 归入所属组，组头按 agentLabel 本地化
// （未知 id 回落 raw）。成功以服务端回读行 react_trace 为权威并按 agent_id 分组；错误时半成品灰显。
// 模型一步直出（无工具调用）时本卡不展示。

type ForecastReasoningCardProps = {
  row: ForecastDbRow | null // done/duplicate 后的权威行（可能 success/failed）
  stream: ForecastStreamState // 流式实时状态：status/phase/steps/markdown/errorCode
}

// 展示用轨迹步：react_trace 的 args 可能是字符串或对象（DB 兜底），统一为可渲染形状
type TraceAction = {
  name: string
  args: string | Record<string, unknown>
  result: string
}
type TraceStep = { thought: string | null; actions: TraceAction[] }

// 参数可能是字符串或对象；对象直接 JSON 序列化展示
function formatArgs(args: string | Record<string, unknown>): string {
  return typeof args === "string" ? args : JSON.stringify(args)
}

// 观察结果是 JSON 字符串：压成单行便于卡片阅读，非法 JSON 原样展示
function formatResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result))
  } catch {
    return result
  }
}

// 工具调用步骤列表：每条 = 工具名徽标 + 参数/观察结果（等宽 log 行）
function TraceList({
  steps,
  t,
}: {
  steps: TraceStep[]
  t: ReturnType<typeof useTranslations<"dashboard.forecast.forecastAgent">>
}) {
  return (
    <ol className="flex flex-col gap-5">
      {steps.map((step, si) => (
        <li key={si} className="flex flex-col gap-2.5">
          {/* 思考文字：流式工具步与旧结构化行均有；空串/null 跳过 */}
          {step.thought && (
            <blockquote className="rounded-r-lg border-l-2 border-sky-300/70 bg-sky-50/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {step.thought}
            </blockquote>
          )}
          <ol className="flex flex-col gap-3">
            {step.actions.map((a, ai) => (
              <li key={ai} className="flex flex-col gap-2">
                {/* 工具名 pill + 多工具步序号；徽标与参数块分层，避免挤在一起 */}
                <div className="flex items-center gap-2">
                  <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-sky-100 px-2 py-0.5 font-mono text-xs font-medium text-sky-700">
                    <Wrench aria-hidden="true" className="size-3" />
                    {a.name}
                  </span>
                  {step.actions.length > 1 && (
                    <span className="text-[11px] tabular-nums text-muted-foreground/60">
                      {ai + 1}/{step.actions.length}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 font-mono text-xs leading-5">
                  {/* 参数/观察结果各带小标签，分隔清晰 */}
                  <div className="break-all">
                    <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {t("toolArgsLabel")}
                    </span>
                    {formatArgs(a.args)}
                  </div>
                  <div className="break-all">
                    <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {t("toolResultLabel")}
                    </span>
                    <span className="text-muted-foreground">
                      {formatResult(a.result)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  )
}

// 组名本地化：固定 id→i18n 映射（supervisor/reconcile/risk）；未知 id 回落 raw
function agentLabel(
  agentId: string,
  t: ReturnType<typeof useTranslations<"dashboard.forecast.forecastAgent">>
): string {
  const key = `agentLabel.${agentId}`
  return t.has(key) ? t(key) : agentId
}

// 多 agent 时间线：按分组渲染，组头 = agent 名 + 组内工具步骤列表。
// 旧行（无 agent 标记，全部归 "" 单组）不加组头，渲染与历史一致
function TimelineList({
  agents,
  t,
}: {
  agents: TimelineGroup[]
  t: ReturnType<typeof useTranslations<"dashboard.forecast.forecastAgent">>
}) {
  const legacyOnly = agents.every((g) => g.agentId === "")
  return (
    <div className="flex flex-col gap-5">
      {agents.map((group, gi) => (
        <section
          key={`${group.agentId}-${gi}`}
          className="flex flex-col gap-2.5"
        >
          {!legacyOnly && group.agentId !== "" && (
            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-sky-400" />
              {agentLabel(group.agentId, t)}
            </h4>
          )}
          <TraceList steps={group.steps} t={t} />
        </section>
      ))}
    </div>
  )
}

// 卡片外观按「流式中/错误/终态」三档切换；顶部分栏样式与左侧城市卡同套天空蓝，保持一行内观感统一。
// 高度与左列城市卡对齐（外层按左卡高度限高）：h-full 撑满限高后的容器，内容区 overflow-y-auto 滚动；
// 流式期轨迹步逐条追加时自动滚到底部（仅当用户本就贴近底部，上翻回读时不抢滚动）。
function ReasoningCardShell({
  stream,
  children,
}: {
  stream: ForecastStreamState
  children: ReactNode
}) {
  const t = useTranslations("dashboard.forecast.forecastAgent")
  const isStreaming = stream.status === "streaming"
  const isError = stream.status === "error"
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  // 流式新增轨迹步时滚到底部展示最新步骤；isStreaming 期间才启用
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !isStreaming) return
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [stream.agents, isStreaming])

  // 滚动位置持续记录：距底 <48px 视为「紧跟底部」，新步骤到来才自动下滚
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  return (
    <ForecastCardShell
      tone={isError ? "error" : "info"}
      dot={isStreaming ? "streaming" : isError ? "error" : "info"}
      title={t("reasoningTitle")}
      phase={isStreaming && stream.phase ? t(`phase.${stream.phase}`) : null}
      className="h-full"
      contentClassName="min-h-0 flex-1 overflow-y-auto"
      contentRef={scrollRef}
      onContentScroll={handleScroll}
    >
      {children}
    </ForecastCardShell>
  )
}

export function ForecastReasoningCard({
  row,
  stream,
}: ForecastReasoningCardProps) {
  const t = useTranslations("dashboard.forecast.forecastAgent")

  // 尚未开始且无行：不占位，等首次点击后出现
  if (stream.status === "idle" && !row) return null

  // —— 流式期：各 agent 分组实时出现；尚无轨迹步时显示占位 + 阶段指示 ——
  if (stream.status === "streaming") {
    return (
      <ReasoningCardShell stream={stream}>
        {stream.agents.length > 0 ? (
          <TimelineList agents={stream.agents} t={t} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("generating")}</p>
        )}
      </ReasoningCardShell>
    )
  }

  // —— 错误态：已累积的轨迹步半成品灰显（错误文案由预报卡统一展示） ——
  if (stream.status === "error") {
    if (stream.agents.length === 0) return null
    return (
      <ReasoningCardShell stream={stream}>
        <div className="opacity-60">
          <TimelineList agents={stream.agents} t={t} />
        </div>
      </ReasoningCardShell>
    )
  }

  // —— done：以服务端回读行 react_trace 为准（权威轨迹）并按 agent 分组；无工具调用/失败行不展示 ——
  if (row && row.status === "success") {
    const trace = row.react_trace ?? []
    if (trace.length === 0) return null
    return (
      <ReasoningCardShell stream={stream}>
        <TimelineList agents={groupByAgent(trace)} t={t} />
      </ReasoningCardShell>
    )
  }
  return null
}
