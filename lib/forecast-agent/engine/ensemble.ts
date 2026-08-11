import type { ConditionCategory, WeatherSource } from "@/lib/schemas/weather"
import type {
  PredictionResult,
  RiskFlag,
  SourceInput,
} from "@/lib/schemas/forecast-agent"

// 确定性集成引擎：三源预报 → 平台自有预测。
// 全部纯函数、公式固定（可复现），供卡上「演算过程」逐行展示与单测

// 公式版本：随行落库，供排查预测口径（改公式逻辑时同步递增）
export const FORMULA_VERSION = "1.0.0"

// 报雨判定：日降水累计 ≥ 此值视为报雨（divergence.ts 复用，防口径漂移）
export const RAIN_THRESHOLD_MM = 0.1

// 统一保留 1 位小数，保证卡上演算与结果可对账
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// 加权均值：权重为 0 或空时返回 0（防御输入缺失）
export function weightedMean(values: number[], weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  return values.reduce((sum, v, i) => sum + v * (weights[i] ?? 0), 0) / total
}

// 加权标准差（总体方差开方），用于预测区间宽度
export function weightedStd(
  values: number[],
  weights: number[],
  mean: number
): number {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  const variance =
    values.reduce((sum, v, i) => sum + (weights[i] ?? 0) * (v - mean) ** 2, 0) /
    total
  return Math.sqrt(variance)
}

// 只累加数值型权重：weights 可能是 Weights（Record + detail 明细字段），
// 直接 Object.values 会混入 detail 对象，求和变字符串导致除出 NaN。
// precipitationProbability 与 confidence 共用（各函数对 total=0 的兜底不同）
function numericWeightSum(weights: Record<WeatherSource, number>): number {
  return Object.values(weights).reduce(
    (s, w) => s + (typeof w === "number" ? w : 0),
    0
  )
}

// 条件加权票数表：conditionVote 与 confidence 共用（跳过条件缺失的源）
function conditionVoteMap(
  inputs: SourceInput[],
  weights: Record<WeatherSource, number>
): Map<ConditionCategory, number> {
  const votes = new Map<ConditionCategory, number>()
  for (const inp of inputs) {
    if (!inp.condition) continue
    votes.set(
      inp.condition,
      (votes.get(inp.condition) ?? 0) + (weights[inp.source] ?? 0)
    )
  }
  return votes
}

// 降水概率：报雨源的权重之和占总权重比例（0-100，四舍五入）
export function precipitationProbability(
  inputs: SourceInput[],
  weights: Record<WeatherSource, number>
): number {
  const total = numericWeightSum(weights)
  if (total === 0) return 0
  const rainWeight = inputs.reduce(
    (s, inp) =>
      inp.precip >= RAIN_THRESHOLD_MM ? s + (weights[inp.source] ?? 0) : s,
    0
  )
  return Math.round((rainWeight / total) * 100)
}

// 降水分级：按加权降水均值映射为 无/小/中/大雨（日累计 mm）
export function precipLevel(
  precip: number
): "none" | "light" | "moderate" | "heavy" {
  if (precip < RAIN_THRESHOLD_MM) return "none"
  if (precip < 10) return "light"
  if (precip < 25) return "moderate"
  return "heavy"
}

// 条件分类：加权多数投票（跳过条件缺失的源；并列取先出现者）
export function conditionVote(
  inputs: SourceInput[],
  weights: Record<WeatherSource, number>
): ConditionCategory {
  const votes = conditionVoteMap(inputs, weights)
  let best: ConditionCategory = "other"
  let bestW = -1
  for (const [cat, w] of votes)
    if (w > bestW) {
      best = cat
      bestW = w
    }
  return best
}

// 风速 m/s → 蒲福风级（标准查表）
export function beaufort(ms: number): number {
  const s = Math.abs(ms)
  if (s < 0.3) return 0
  if (s < 1.6) return 1
  if (s < 3.4) return 2
  if (s < 5.5) return 3
  if (s < 8.0) return 4
  if (s < 10.8) return 5
  if (s < 13.9) return 6
  if (s < 17.2) return 7
  if (s < 20.8) return 8
  if (s < 24.5) return 9
  if (s < 28.5) return 10
  if (s < 32.7) return 11
  return 12
}

// 预测区间：均值 ± z×加权标准差（默认 z=1.28 ≈ 80% 置信），保留 1 位小数
export function predictionInterval(
  mean: number,
  std: number,
  z = 1.28
): [number, number] {
  return [round1(mean - z * std), round1(mean + z * std)]
}

// 置信度：不依赖真值，只看「源之间一致强度」——多数派权重占比越高越可信
export function confidence(
  inputs: SourceInput[],
  weights: Record<WeatherSource, number>
): "high" | "medium" | "low" {
  const total = numericWeightSum(weights) || 1
  const votes = conditionVoteMap(inputs, weights)
  const share = Math.max(0, ...votes.values()) / total
  if (share >= 0.75) return "high"
  if (share >= 0.5) return "medium"
  return "low"
}

// 风险标记阈值：一处集中定义，卡上演算与校验共用
export const RISK_THRESHOLDS = {
  heatHigh: 35, // 预测高温 ≥ 35°C
  coldLow: 0, // 预测低温 ≤ 0°C
  heavyRain: 25, // 降水 ≥ 25mm
  windBeaufort: 6, // 风力 ≥ 6 级
  diurnal: 10, // 昼夜温差 ≥ 10°C（info 提醒）
  minSources: 2, // 判定一致所需源数
} as const

// 风险标记：阈值 + ≥minSources 源一致才标，防单源误报
export function riskFlags(
  inputs: SourceInput[],
  pred: {
    high: number
    low: number
    precip: number
    poP: number
    windBeaufort: number
    condition: ConditionCategory
  }
): RiskFlag[] {
  const flags: RiskFlag[] = []

  // 某条件的源数（非加权票数，做「≥minSources 一致」判定）
  const conditionSources = new Map<ConditionCategory, number>()
  for (const inp of inputs) {
    if (!inp.condition) continue
    conditionSources.set(
      inp.condition,
      (conditionSources.get(inp.condition) ?? 0) + 1
    )
  }
  const count = (cat: ConditionCategory) => conditionSources.get(cat) ?? 0

  if (pred.high >= RISK_THRESHOLDS.heatHigh) {
    flags.push({ type: "heat", level: "warning", sources: inputs.length })
  }
  if (pred.low <= RISK_THRESHOLDS.coldLow) {
    flags.push({ type: "cold", level: "warning", sources: inputs.length })
  }
  if (pred.precip >= RISK_THRESHOLDS.heavyRain && pred.poP >= 60) {
    flags.push({ type: "heavyRain", level: "warning", sources: inputs.length })
  }
  if (pred.windBeaufort >= RISK_THRESHOLDS.windBeaufort) {
    flags.push({ type: "wind", level: "warning", sources: inputs.length })
  }
  if (
    pred.condition === "storm" &&
    count("storm") >= RISK_THRESHOLDS.minSources
  ) {
    flags.push({ type: "storm", level: "warning", sources: count("storm") })
  }
  if (
    pred.condition === "snow" &&
    count("snow") >= RISK_THRESHOLDS.minSources
  ) {
    flags.push({ type: "snow", level: "warning", sources: count("snow") })
  }
  if (pred.high - pred.low >= RISK_THRESHOLDS.diurnal) {
    flags.push({ type: "diurnal", level: "info", sources: inputs.length })
  }
  return flags
}

// 主入口：聚合输入 → 各模板指标 → 完整预测结果
export function predict(
  inputs: SourceInput[],
  weights: Record<WeatherSource, number>
): PredictionResult {
  // 入参可能是 Weights（Record + detail 明细字段）。聚合只认三源权重，
  // 显式抽取成纯权重表，后续计算与 result.weights 都基于它，避免 detail 混入求和/落库
  const sourceWeights: Record<WeatherSource, number> = {
    "open-meteo": weights["open-meteo"] ?? 0,
    openweather: weights.openweather ?? 0,
    weatherapi: weights.weatherapi ?? 0,
  }

  // 按可用值配对（某源缺湿度/风时跳过，权重对剩余源归一）
  const pair = (get: (i: SourceInput) => number | null) => {
    const vals: number[] = []
    const ws: number[] = []
    for (const inp of inputs) {
      const v = get(inp)
      if (v == null) continue
      vals.push(v)
      ws.push(sourceWeights[inp.source])
    }
    return { vals, ws }
  }

  const high = pair((i) => i.high)
  const low = pair((i) => i.low)
  const precip = pair((i) => i.precip)
  const wind = pair((i) => i.windMs)
  const hum = pair((i) => i.humidity)

  const highMean = weightedMean(high.vals, high.ws)
  const lowMean = weightedMean(low.vals, low.ws)
  const precipMean = weightedMean(precip.vals, precip.ws)
  const windMean = weightedMean(wind.vals, wind.ws)
  const humidityMean = weightedMean(hum.vals, hum.ws)
  const poP = precipitationProbability(inputs, sourceWeights)
  const condition = conditionVote(inputs, sourceWeights)

  const core = {
    high: round1(highMean),
    low: round1(lowMean),
    precip: round1(precipMean),
    poP,
    windBeaufort: beaufort(windMean),
    condition,
  }

  const sourceInputs: Record<string, SourceInput> = {}
  for (const inp of inputs) sourceInputs[inp.source] = inp

  return {
    high: core.high,
    low: core.low,
    highInterval: predictionInterval(
      highMean,
      weightedStd(high.vals, high.ws, highMean)
    ),
    lowInterval: predictionInterval(
      lowMean,
      weightedStd(low.vals, low.ws, lowMean)
    ),
    poP,
    precipLevel: precipLevel(precipMean),
    condition,
    windBeaufort: core.windBeaufort,
    windMs: round1(windMean),
    humidity: round1(humidityMean),
    confidence: confidence(inputs, sourceWeights),
    riskFlags: riskFlags(inputs, core),
    weights: sourceWeights,
    sourceInputs,
  }
}
