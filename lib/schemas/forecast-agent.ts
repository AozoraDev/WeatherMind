import { z } from "zod"

import type { ConditionCategory, WeatherSource } from "@/lib/schemas/weather"

// ForecastAgent 的信任边界 schema：
// - PredictionResult / SourceInput / ForecastDbRow 是内部可信数据（仅类型来源）
// - chatResponseSchema 是外部 AI 响应（运行时 Zod 校验）
// - METRICS 是模板指标 id 常量，AI 文本引用与工具参数校验都用它（单一来源）

// —— 指标 id 常量（AI 引用用，一致性闸门校验） ——
export const METRICS = {
  high: "predicted_high",
  low: "predicted_low",
  highInterval: "high_interval",
  lowInterval: "low_interval",
  poP: "precipitation_probability",
  precipLevel: "precip_level",
  condition: "condition",
  wind: "wind",
  humidity: "humidity",
  confidence: "confidence",
  risk: "risk_flags",
} as const

export type MetricId = (typeof METRICS)[keyof typeof METRICS]

// —— 输入聚合（每个源一组，可信内部数据） ——
export type SourceInput = {
  source: WeatherSource
  high: number // 当日预报高温 °C
  low: number // 当日预报低温 °C
  precip: number // 当日降水累计 mm
  condition: ConditionCategory | null // 归一粗分类，可缺
  humidity: number | null // 相对湿度 %，可缺
  windMs: number | null // 风速 m/s，可缺
}

// —— 确定性内核输出 ——
export type RiskFlag = {
  type: string
  level: "info" | "warning"
  sources: number
}

export type PredictionResult = {
  high: number
  low: number
  highInterval: [number, number]
  lowInterval: [number, number]
  poP: number // 降水概率 0-100
  precipLevel: "none" | "light" | "moderate" | "heavy"
  condition: ConditionCategory
  windBeaufort: number
  windMs: number
  humidity: number
  confidence: "high" | "medium" | "low"
  riskFlags: RiskFlag[]
  weights: Record<WeatherSource, number>
  sourceInputs: Record<WeatherSource, SourceInput>
}

// —— ReAct 推理轨迹（落库/卡片读回用） ——
// 卡片把 DB 读回的 jsonb 当作信任边界用 safeParse 兜底，故轨迹本身也是 schema；
// args 存模型原始参数字符串（非法 JSON 时兜底为对象），result 是工具观察结果的 JSON 字符串
export const reactActionSchema = z.object({
  name: z.string(),
  args: z.union([z.string(), z.record(z.string(), z.unknown())]),
  result: z.string(),
})

export const reactTraceStepSchema = z.object({
  thought: z.string().nullable(), // 本轮 assistant 文本（无则 null）
  actions: z.array(reactActionSchema),
})

export const reactTraceSchema = z.array(reactTraceStepSchema)

export type ReactTrace = z.infer<typeof reactTraceSchema>

// —— OpenAI 兼容 chat 响应（不可信） ——
// usage 是 OpenAI 兼容接口的标准计费字段（prompt/completion/total），
// 部分代理缺省，故整块可选；缺省时卡片该行显示 — 而非报错
export const chatUsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
})

export type ChatUsage = z.infer<typeof chatUsageSchema>

export const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              })
            )
            .optional(),
        }),
      })
    )
    .min(1),
  usage: chatUsageSchema.optional(),
})

// —— ForecastAgent 预测行（snake_case，对应 0006 表结构） ——
// jsonb 字段在 DB 边界断言为具体形状；status 与表 check 约束一致
export type ForecastDbRow = {
  id: string
  city_id: string
  day: string
  locale: string
  status: "pending" | "success" | "failed"
  predicted_high: number | null
  predicted_low: number | null
  high_interval: [number, number] | null
  low_interval: [number, number] | null
  precipitation_probability: number | null
  precip_level: string | null
  condition: string | null
  wind_beaufort: number | null
  wind_speed: number | null
  humidity: number | null
  confidence: string | null
  risk_flags: RiskFlag[] | null
  weights: Record<string, number> | null
  source_inputs: Record<string, SourceInput> | null
  formula_version: string | null
  summary: string | null
  points: { metricId: string; text: string }[] | null
  advice: string | null
  model: string | null
  prompt_tokens: number | null // AI 生成输入 token（usage 缺省时 null）
  completion_tokens: number | null // AI 生成输出 token
  error_code: string | null
  failed_at: string | null // 最近一次失败时刻（失败冷却计时基准，成功行 null）
  created_by: string | null
  created_at: string
  updated_at: string
  react_trace: ReactTrace | null // ReAct 推理轨迹（仅成功行写入；一步直出时为空数组）
  markdown_body: string | null // AI 纯 Markdown 输出全文（## 推理过程 + ## 预报）；旧结构化行此列为 null
}

// tools.ts 的工具参数校验复用：判定某字符串是否为合法指标 id
export function isMetricId(id: string): id is MetricId {
  return (Object.values(METRICS) as string[]).includes(id)
}

// —— 纯 Markdown 输出校验（契约：AI 输出 ## 推理过程 + ## 预报 两段） ——
// 新契约没法校验 metricId 引用（无结构化 points），改为轻量文本校验：
// 两段齐 + 关键数值（high/low/poP）与确定性集成结果容差内一致 + 防胡编（温度/百分比钳制）。
// 注意预报正文必须含温度数字，故不再禁止温度单位（与旧铁律相反）

// 切分标题：按语言各一组（prompt.ts 输出契约与这里对齐）
export const REASONING_HEADINGS = ["## 推理过程", "## Reasoning"] as const
export const FORECAST_HEADINGS = ["## 预报", "## Forecast"] as const

export type MarkdownDoc = { reasoning: string; forecast: string }

// 找第一个以指定标题开头的行号（行首 trim 后前缀匹配，容忍标题后跟空白/空格）
function findHeadingLine(md: string, headings: readonly string[]): number {
  const lines = md.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (headings.some((h) => line.startsWith(h))) return i
  }
  return -1
}

// 切分文档：reasoning = 推理标题后、预报标题前；forecast = 预报标题后。
// 任一标题缺失或顺序颠倒（预报在推理前）→ null
export function splitMarkdownDoc(md: string): MarkdownDoc | null {
  const reasonLine = findHeadingLine(md, REASONING_HEADINGS)
  const forecastLine = findHeadingLine(md, FORECAST_HEADINGS)
  if (reasonLine === -1 || forecastLine === -1 || forecastLine <= reasonLine)
    return null
  const lines = md.split("\n")
  return {
    reasoning: lines
      .slice(reasonLine + 1, forecastLine)
      .join("\n")
      .trim(),
    forecast: lines
      .slice(forecastLine + 1)
      .join("\n")
      .trim(),
  }
}

// 温度上下文数值：数字 + 温度单位（°C/℃/摄氏度/度/Celsius/degrees）
export const TEMP_VALUE_RE =
  /([-+]?\d+(?:\.\d+)?)\s*(?:℃|°C|摄氏度|度|Celsius|degrees?)/g
// 百分比数值
export const PERCENT_VALUE_RE = /(\d+(?:\.\d+)?)\s*%/g

function extractTemperatures(text: string): number[] {
  const vals: number[] = []
  for (const m of text.matchAll(TEMP_VALUE_RE)) vals.push(Number(m[1]))
  return vals
}

export type MarkdownValidation =
  { ok: true; doc: MarkdownDoc } | { ok: false; issues: string[] }

// 轻量校验（默认：温度容差 2.5°C、poP 容差 10、最小长度 80、温度钳制 -40~60）：
// 1. 两段齐（splitMarkdownDoc 非 null）
// 2. 全文长度达标、两段均非空
// 3. forecast 段含与集成 high/low 差 ≤ tempTolerance 的温度值、与 poP 差 ≤ popTolerance 的 % 值
//    （poP=0 时允许「无降水」类措辞而不必写 0%）
// 4. 防胡编：forecast 段温度值都在 tempClamp 内、% 值 ≤ 100
export function validateMarkdownDoc(
  md: string,
  result: PredictionResult,
  opts?: {
    tempTolerance?: number
    popTolerance?: number
    minLength?: number
    tempClamp?: [number, number]
  }
): MarkdownValidation {
  const tempTolerance = opts?.tempTolerance ?? 2.5
  const popTolerance = opts?.popTolerance ?? 10
  const minLength = opts?.minLength ?? 80
  const tempClamp = opts?.tempClamp ?? [-40, 60]

  const issues: string[] = []

  const doc = splitMarkdownDoc(md)
  if (!doc) {
    issues.push("missing-sections")
    return { ok: false, issues } // 两段缺失后续无法继续，直接返回
  }
  if (md.trim().length < minLength) issues.push("too-short")
  if (!doc.reasoning) issues.push("empty-reasoning")
  if (!doc.forecast) issues.push("empty-forecast")

  // 关键指标与集成结果一致性（正向）
  const temps = extractTemperatures(doc.forecast)
  const percents = [...doc.forecast.matchAll(PERCENT_VALUE_RE)].map((m) =>
    Number(m[1])
  )
  if (!temps.some((t) => Math.abs(t - result.high) <= tempTolerance))
    issues.push("high-mismatch")
  if (!temps.some((t) => Math.abs(t - result.low) <= tempTolerance))
    issues.push("low-mismatch")
  // poP=0 时允许「无降水」措辞，不必写 0%
  const poPZero = result.poP === 0
  if (
    !poPZero &&
    !percents.some((p) => Math.abs(p - result.poP) <= popTolerance)
  )
    issues.push("pop-mismatch")

  // 防胡编：温度在合理钳制内、百分比 ≤ 100
  if (temps.some((t) => t < tempClamp[0] || t > tempClamp[1]))
    issues.push("temperature-out-of-range")
  if (percents.some((p) => p > 100)) issues.push("percent-out-of-range")

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, doc }
}
