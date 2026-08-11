"use client"

import { useLocale, useTranslations } from "next-intl"

import { METRICS, type ForecastDbRow } from "@/lib/schemas/forecast-agent"
import type { CityRow } from "@/lib/weather/view-types"
import type { ForecastStreamState } from "@/hooks/use-forecast-stream"

import { ForecastCardShell } from "@/components/ui-preset/forecast-card-shell"
import { Markdown } from "@/components/ui-preset/markdown"
import { ForecastMetricsGrid } from "@/components/dashboard/forecast/forecast-metrics-grid"

// ForecastAgent 结果卡片：只做展示，不负责触发生成。
// 成功态顶部渲染指标图标卡（ForecastMetricsGrid，权威结构化字段），下方保留 AI 的完整
// Markdown 正文（## 推理过程 + ## 预报）；ReAct 工具调用过程在右侧 ForecastReasoningCard
// 独立展示。流式期渲染全文实时增量；成功后新行（markdown_body 非空）整卡 = 指标卡 + Markdown，
// 旧结构化行（markdown_body 为 null）兜底走 summary/points/advice + 指标卡；
// failed/error 显示受限错误码。卡片由 useForecastStream 驱动：idle 且无行时不占位，首次点击后才出现。

type ForecastAgentCardProps = {
  city: CityRow
  row: ForecastDbRow | null // done/duplicate 后的权威行（可能 success/failed）
  stream: ForecastStreamState // 流式实时状态：status/phase/markdown/errorCode
}

// 已知失败错误码集合，防御非法 error_code 不落到 i18n 缺失键
const ERROR_KEYS = new Set([
  "no-model",
  "retry-cooldown",
  "insufficient-data",
  "provider",
  "parse",
  "consistency",
  "react-loop",
  "generic",
])

// 页脚：权重/公式版本/模型/token（新 Markdown 行与旧结构化行共用）
function CardFooterMeta({
  row,
  t,
  sep,
}: {
  row: ForecastDbRow
  t: ReturnType<typeof useTranslations<"dashboard.forecast.forecastAgent">>
  sep: string
}) {
  const weights = (row.weights ?? {}) as Record<string, number>
  // 只展示数值型源权重：旧行/异常数据可能带 detail 明细字段，混入会显示 [object Object]
  const weightsText = Object.entries(weights)
    .filter(([, w]) => typeof w === "number")
    .map(([s, w]) => `${s} ${w}`)
    .join(" · ")

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground">
      {weightsText && (
        <span>
          {t("weightsLabel")}
          {sep}
          <span className="text-foreground">{weightsText}</span>
        </span>
      )}
      {row.formula_version && (
        <span>
          {t("formulaLabel")}
          {sep}
          <span className="text-foreground">{row.formula_version}</span>
        </span>
      )}
      {row.model && (
        <span>
          {t("modelLabel")}
          {sep}
          <span className="text-foreground">{row.model}</span>
        </span>
      )}
      {/* 本次生成的 token 消耗：只有代理回传 usage 且成功落库才显示 */}
      {row.prompt_tokens != null && row.completion_tokens != null && (
        <span>
          {t("tokensLabel")}
          {sep}
          <span className="text-foreground">
            {row.prompt_tokens + row.completion_tokens}
            <span className="text-muted-foreground">
              {t("tokensInOut", {
                prompt: row.prompt_tokens,
                output: row.completion_tokens,
              })}
            </span>
          </span>
        </span>
      )}
    </footer>
  )
}

// 旧结构化行兜底：summary/points/advice + 演算过程（历史上已生成的旧行 markdown_body 为 null）
function LegacyRowCard({
  city,
  row,
  t,
  sep,
}: {
  city: CityRow
  row: ForecastDbRow
  t: ReturnType<typeof useTranslations<"dashboard.forecast.forecastAgent">>
  sep: string
}) {
  return (
    <ForecastCardShell
      tone="success"
      title={`${t("title")} · ${city.name_ja} ${city.name_en} · ${row.day}（${t("localDay")}）`}
      contentClassName="flex flex-col gap-4"
    >
      {row.summary && (
        <section>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("summaryLabel")}
          </p>
          <p className="text-sm leading-6">{row.summary}</p>
        </section>
      )}

      {/* 预报指标图标卡：固定模板指标，全部由确定性代码计算、可复现 */}
      <ForecastMetricsGrid row={row} />

      {row.points && row.points.length > 0 && (
        <section>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("pointsLabel")}
          </p>
          <ul className="flex flex-col gap-1">
            {row.points.map((p, i) => (
              <li key={i} className="flex items-start gap-2 text-sm leading-6">
                <span className="mt-0.5 shrink-0 rounded bg-emerald-100 px-1 text-xs text-emerald-700">
                  {metricLabel(p.metricId, t)}
                </span>
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {row.advice && (
        <section>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("adviceLabel")}
          </p>
          <p className="text-sm leading-6">{row.advice}</p>
        </section>
      )}

      <CardFooterMeta row={row} t={t} sep={sep} />
    </ForecastCardShell>
  )
}

export function ForecastAgentCard({
  city,
  row,
  stream,
}: ForecastAgentCardProps) {
  const t = useTranslations("dashboard.forecast.forecastAgent")
  const locale = useLocale()
  // 英文界面用 ASCII 冒号、中文用全角（footer 各标签统一跟随语言）
  const sep = locale === "en" ? ": " : "："

  // 尚未开始且无行：卡片不占位，等首次点击后出现
  if (stream.status === "idle" && !row) return null

  // —— 流式期：实时渲染 Markdown 增量 + 阶段指示 ——
  if (stream.status === "streaming") {
    const phaseKey = stream.phase
    return (
      <ForecastCardShell
        tone="success"
        dot="streaming"
        title={`${t("title")} · ${city.name_ja} ${city.name_en}`}
        phase={phaseKey ? t(`phase.${phaseKey}`) : null}
      >
        {stream.markdown ? (
          <Markdown>{stream.markdown}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">{t("generating")}</p>
        )}
      </ForecastCardShell>
    )
  }

  // —— 错误态：已流式出的半成品保留灰显（校验失败/中途出错），未出内容只显错误文案 ——
  if (stream.status === "error") {
    const code =
      stream.errorCode && ERROR_KEYS.has(stream.errorCode)
        ? stream.errorCode
        : "generic"
    return (
      <ForecastCardShell
        tone="error"
        dot="none"
        title={`${t("failed")} · ${city.name_ja} ${city.name_en}`}
        contentClassName="flex flex-col gap-2"
      >
        <p className="text-sm text-destructive">{t(`error.${code}`)}</p>
        {stream.markdown && (
          <Markdown className="opacity-60">{stream.markdown}</Markdown>
        )}
      </ForecastCardShell>
    )
  }

  // —— done：以服务端回读行为准 ——
  // duplicate/failed 行（已存在但生成失败）：显示失败错误
  if (row && row.status === "failed") {
    const code =
      row.error_code && ERROR_KEYS.has(row.error_code)
        ? row.error_code
        : "generic"
    return (
      <ForecastCardShell
        tone="error"
        dot="none"
        title={`${t("failed")} · ${city.name_ja} ${city.name_en}`}
      >
        <p className="text-sm text-destructive">{t(`error.${code}`)}</p>
      </ForecastCardShell>
    )
  }

  // 成功行：新行 = 指标图标卡 + 纯 Markdown；旧行（markdown_body null）兜底结构化
  if (row) {
    if (row.markdown_body) {
      return (
        <ForecastCardShell
          tone="success"
          title={`${t("title")} · ${city.name_ja} ${city.name_en} · ${row.day}（${t("localDay")}）`}
          contentClassName="flex flex-col gap-4"
        >
          {/* 预报指标图标卡（权威结构化字段）+ AI 正文全文（推理过程 + 预报叙述） */}
          <ForecastMetricsGrid row={row} />
          <Markdown>{row.markdown_body}</Markdown>
          <CardFooterMeta row={row} t={t} sep={sep} />
        </ForecastCardShell>
      )
    }
    return <LegacyRowCard city={city} row={row} t={t} sep={sep} />
  }

  // 兜底：idle 但 row 为 null（理论不达）
  return null
}

// points 徽标：metricId → i18n 短标签（metricBadge 命名空间；与演算过程 label 解耦）
const BADGE_KEYS: Record<string, string> = {
  [METRICS.high]: "high",
  [METRICS.low]: "low",
  [METRICS.highInterval]: "highInterval",
  [METRICS.lowInterval]: "lowInterval",
  [METRICS.poP]: "poP",
  [METRICS.precipLevel]: "precipLevel",
  [METRICS.condition]: "condition",
  [METRICS.wind]: "wind",
  [METRICS.humidity]: "humidity",
  [METRICS.confidence]: "confidence",
  [METRICS.risk]: "risk",
}

function metricLabel(
  id: string,
  t: ReturnType<typeof useTranslations<"dashboard.forecast.forecastAgent">>
): string {
  return t(`metricBadge.${BADGE_KEYS[id] ?? id}`)
}
