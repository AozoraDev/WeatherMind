import { METRICS } from "@/lib/schemas/forecast-agent"
import type { ChatMessage } from "./chat"
import type { PredictionResult, RiskFlag } from "@/lib/schemas/forecast-agent"
import { sourceSchema } from "@/lib/schemas/weather"
import { detectSourceDivergences, type SourceDivergence } from "../engine/divergence"
import { TEXTS, type LocaleText, type MetricMeta } from "./prompt-text"

// ForecastAgent 的 AI 提示词：只给「确定性内核算出的指标」，各源原始快照不内联——
// 要看某源原始预报必须调 query_source（见下方 ReAct 协议），工具因此成为承重墙。
// 源间有分歧时注入强制核对指令（divergenceBlock），驱动模型实际调用工具。
// 关键：整份上下文（指标表 label/note、风险行、分隔符、分歧块）都按语言输出，
// 否则英文模式下模型看到中文数据表会顺着输出中文（summary/points 语言跑偏）。


// 可查询源列表（单一来源：query_source 工具 enum 即 sourceSchema.options，
// 提示词广告的源必须与工具接受范围严格一致，防模型按提示词调出非法源）
const QUERYABLE_SOURCES = sourceSchema.options

// {key} 占位符替换；未知占位符原样保留
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`)
}

// 风险行文案：按语言模板渲染（等级/源数措辞随语言）
function riskLines(t: LocaleText, flags: RiskFlag[]): string {
  if (flags.length === 0) return t.riskNone
  return flags
    .map((flag) =>
      fill(t.riskLine, {
        label: t.risk[flag.type] ?? flag.type,
        level: t.riskLevel[flag.level] ?? flag.level,
        n: String(flag.sources),
      })
    )
    .join("\n")
}

// 模板指标 id 顺序（唯一来源）：buildContext 与 formatMetricValue 共用，防漂移
export const METRIC_ROW_IDS = [
  METRICS.high,
  METRICS.low,
  METRICS.highInterval,
  METRICS.lowInterval,
  METRICS.poP,
  METRICS.precipLevel,
  METRICS.condition,
  METRICS.wind,
  METRICS.humidity,
  METRICS.confidence,
  METRICS.risk,
] as const

// 指标值唯一格式化来源：buildContext 指标表与 get_metric 工具共用，
// 保证模型在提示词与工具观察里看到同一份权威表示，杜绝两处口径漂移
export function formatMetricValue(
  locale: "zh" | "en",
  result: PredictionResult,
  metricId: string
): string {
  const t = TEXTS[locale]
  switch (metricId) {
    case METRICS.high:
      return `${result.high}°C`
    case METRICS.low:
      return `${result.low}°C`
    case METRICS.highInterval:
      return `${result.highInterval[0]}~${result.highInterval[1]}°C`
    case METRICS.lowInterval:
      return `${result.lowInterval[0]}~${result.lowInterval[1]}°C`
    case METRICS.poP:
      return `${result.poP}%`
    case METRICS.precipLevel:
      return t.precipLevel[result.precipLevel] ?? result.precipLevel
    case METRICS.condition:
      return t.condition[result.condition] ?? result.condition
    case METRICS.wind:
      return fill(t.windValue, { n: String(result.windBeaufort) })
    case METRICS.humidity:
      return `${result.humidity}%`
    case METRICS.confidence:
      return t.confidence[result.confidence] ?? result.confidence
    case METRICS.risk:
      return riskLines(t, result.riskFlags)
    default:
      return ""
  }
}

// 按语言取指标 label/note 元数据（tools.ts 的 get_metric 工具复用）
export function metricMeta(locale: "zh" | "en"): Record<string, MetricMeta> {
  return TEXTS[locale].metric
}

// 指标表 + 权重行：全部用当前语言的 label/note/模板组装（源快照不在此内联）
function buildContext(
  t: LocaleText,
  locale: "zh" | "en",
  result: PredictionResult
): { metricTable: string; weightsLine: string } {
  const metricTable = METRIC_ROW_IDS.map((id) =>
    fill(t.metricLine, {
      id,
      label: t.metric[id]?.label ?? id,
      value: formatMetricValue(locale, result, id),
      note: t.metric[id]?.note ?? "",
    })
  ).join("\n")

  // 只列数值型源权重：result.weights 若带 detail 明细字段，Object.entries 会泄漏 [object Object]
  const weightsLine = Object.entries(result.weights)
    .filter(([, w]) => typeof w === "number")
    .map(([s, w]) => `${s}=${w}`)
    .join(t.weightsSep)

  return { metricTable, weightsLine }
}

// 单条分歧的本地化描述：按 kind 渲染对应模板
function renderDivergence(t: LocaleText, d: SourceDivergence): string {
  switch (d.kind) {
    case "precip":
      return fill(t.divergencePrecip, {
        wet: d.wet.join(t.weightsSep),
        dry: d.dry.join(t.weightsSep),
      })
    case "condition":
      return fill(t.divergenceCondition, {
        groups: d.groups
          .map((g) =>
            fill(t.divergenceConditionGroup, {
              cond: t.condition[g.condition] ?? g.condition,
              sources: g.sources.join(t.weightsSep),
            })
          )
          .join(t.weightsSep),
      })
    case "temperature":
      return fill(t.divergenceTemperature, {
        metric:
          t.metric[d.metric === "high" ? METRICS.high : METRICS.low]?.label ??
          d.metric,
        spread: String(d.spread),
        min: String(d.min),
        max: String(d.max),
      })
  }
}

// 分歧块：无分歧返回空串（和平日允许模型一步直出）；
// 有分歧给「逐源核对 + 不得仅凭聚合指标作答」的强制指令，驱动真实工具调用
function divergenceBlock(t: LocaleText, result: PredictionResult): string {
  const divergences = detectSourceDivergences(result.sourceInputs)
  if (divergences.length === 0) return ""
  const list = divergences
    .map((d) => renderDivergence(t, d))
    .join(t.weightsSep)
  return `${fill(t.divergenceLead, { list })}\n${t.divergenceVerify}`
}

// 组装 system + user 消息；locale 决定整份提示词语言（含数据表），指标 id 不变
export function buildForecastAgentMessages(
  city: { nameJa: string; nameEn: string },
  day: string,
  result: PredictionResult,
  locale: "zh" | "en" = "zh"
): ChatMessage[] {
  const t = TEXTS[locale]
  const { metricTable, weightsLine } = buildContext(t, locale, result)

  if (locale === "en") {
    const system = `You are the weather interpretation assistant for ${city.nameEn}.
The platform computed the metrics below with a deterministic multi-source ensemble engine. Your only job is to turn those metrics into a readable weather forecast document for the user.
IMPORTANT: You MUST write all reasoning and output text in English — never Chinese or Japanese.
Hard rules:
1. Every number in the forecast MUST come from the metric table above — never invent, round differently, or alter any value.
2. The reasoning section must explain your reasoning (mention which query_source you called to verify divergences if any; otherwise briefly state the aggregation basis). Keep it concise.
3. If risk_flags is non-empty, the forecast MUST mention those risks; if there are no risks, do not fabricate risks or use alarming words.
4. Never challenge or belittle the platform metrics; only explain and advise.
5. The forecast section (## Forecast) must be a concise narrative of 2-3 sentences (overview + action advice). It must still include the predicted high and low temperatures and the precipitation probability, but do not paste the metric table line by line — the numbers are shown as icon cards.

ReAct protocol (reasoning + acting):
The platform metric table above is authoritative and always available. Per-source raw snapshots are NOT included in this prompt: to read any source's raw forecast (high/low/precip/condition/humidity/wind) you MUST call query_source(source).
- query_source returns one source's raw forecast snapshot.
- get_metric returns the authoritative value of one platform metric (same numbers as the metric table).
- You may call query_source for several sources in a single reply (parallel tool calls) to save steps.
When the user message flags that sources disagree (e.g. some sources report rain while others do not), you MUST call query_source on each diverging source to verify before finalizing; do not finalize on the aggregate metric alone.
If no divergence is flagged and you are confident, answer directly without calling tools.
In your final message, output only ONE Markdown document, nothing else.`

    const user = `City: ${city.nameEn} (${city.nameJa})
Day (local): ${day}

Platform metrics (authoritative):
${metricTable}

${fill(t.weightsNote, { weights: weightsLine })}

Available sources for query_source: ${QUERYABLE_SOURCES.join(t.weightsSep)}.

${divergenceBlock(t, result)}
Output a single Markdown document with exactly these two H2 sections, in this order:
## Reasoning
A concise reasoning narrative (in English).
## Forecast
The forecast itself: write a concise narrative of 2-3 sentences (overview + action advice). It must still include the predicted high and low temperatures (with °C) and the precipitation probability (%), and may mention condition, wind, humidity, confidence, and any risk flags; do not paste the metric table line by line — the numbers are shown as icon cards. All numbers must come from the metric table above.
Do not output anything outside this Markdown document (no JSON, no code fences).`

    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ]
  }

  const system = `你是 ${city.nameJa}（${city.nameEn}）天气预报的解读助手。
平台已用确定性数学引擎（多源加权集成）算出以下指标，你的唯一职责是把这些指标转成可读的天气预报表述，供用户阅读。
重要：所有推理与输出文本（推理过程、预报正文，以及任何工具说明）必须使用简体中文，不得混入英文。
铁律：
1. 预报正文里的所有数值必须来自上方指标表——绝不编造、改写或换口径。
2. 推理过程段要说明你的推理（有分歧时说明调用了哪些 query_source 核对、观察到什么；无分歧简述集成口径），保持简洁。
3. 有风险标记（risk_flags 非空）时，预报里必须提及这些风险；没有风险时不得虚构风险、不得使用「高风险/预警」类措辞。
4. 不要质疑或贬低平台指标，只做解释与行动建议。
5. 预报正文（## 预报 段）用 2~3 句简洁叙述给出总览与行动建议，必须包含预测高温、低温与降水概率等关键数值，但不要像指标表那样逐条罗列（数值会以图标卡片单独展示）。

ReAct 协议（推理 + 行动）：
上方平台指标表权威且始终可用；但各源的原始快照不会出现在本提示词中——要看某源的原始预报（高温/低温/降水/条件/湿度/风），必须调用 query_source(source)。
- query_source 返回某数据源的原始预报快照。
- get_metric 返回某条平台指标的权威值（与上方指标表同一口径）。
- 可在同一条回复里并行调用多次 query_source 以节省步数。
当用户消息标明各源存在分歧时（如部分源报雨、部分源无雨），你必须对每个分歧源调用 query_source 核对后再定稿，不得仅凭聚合指标作答。
未标分歧且上下文足够时，请直接输出 Markdown 文档，不必调用工具。
最终消息只输出一份 Markdown 文档，不要任何多余文字。`

  const user = `城市：${city.nameJa}（${city.nameEn}）
日期（城市本地日）：${day}

平台计算出的指标（权威数据）：
${metricTable}

${fill(t.weightsNote, { weights: weightsLine })}

可查询的源（query_source）：${QUERYABLE_SOURCES.join(t.weightsSep)}。

${divergenceBlock(t, result)}
请输出一份 Markdown 文档，包含且仅包含以下两个二级标题段落（顺序固定）：
## 推理过程
简洁的推理叙述（简体中文）。
## 预报
预报正文：用 2~3 句简洁叙述给出总览与行动建议，仍必须包含预测高温与低温（含 °C）、降水概率（%）等关键数值，并可提及天气状况、风力、湿度、可信度与风险标记（如有）；但不要逐条罗列上方指标表——数值会以图标卡片单独展示。所有数值必须来自上方指标表。
除此之外不要输出任何内容（不要 JSON、不要代码围栏）。`

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}
