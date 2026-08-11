import { METRICS } from "@/lib/schemas/forecast-agent"
import type { ConditionCategory } from "@/lib/schemas/weather"

// ForecastAgent 提示词的本地化文案表：zh/en 各一份，占位符统一 {key} 由 fill 替换。
// MetricMeta 也放这里（LocaleText.metric 的类型），prompt.ts 只做消息组装，不背文案数据

export type MetricMeta = { label: string; note: string }

export type LocaleText = {
  metricLine: string // {id} {label} {value} {note}
  windValue: string // {n} → 蒲福风级值文案
  weightsSep: string // 各源权重/列表分隔符
  riskLine: string // {label} {level} {n} → 风险行
  riskNone: string
  weightsNote: string // {weights}
  condition: Record<ConditionCategory, string> // 条件类别标签
  precipLevel: Record<string, string> // 降水等级标签（none/light/moderate/heavy）
  confidence: Record<string, string> // 可信度标签（high/medium/low）
  divergenceLead: string // {list} → 分歧块引言
  divergenceVerify: string // 强制核对指令
  divergencePrecip: string // {wet} {dry} → 降水分歧描述
  divergenceCondition: string // {groups} → 条件分歧描述
  divergenceConditionGroup: string // {cond} {sources} → 单组条件分歧
  divergenceTemperature: string // {metric} {spread} {min} {max} → 温差分歧描述
  metric: Record<string, MetricMeta>
  risk: Record<string, string>
  riskLevel: Record<string, string>
}

export const TEXTS: Record<"zh" | "en", LocaleText> = {
  zh: {
    metricLine: "- {id}（{label}）：{value}　※{note}",
    windValue: "{n} 级",
    weightsSep: "，",
    riskLine: "- {label}（{level}）：{n} 个数据源一致",
    riskNone: "（无风险标记）",
    weightsNote: "各源权重（{weights}）：权重越高该源越可信。",
    condition: {
      clear: "晴",
      partlyCloudy: "多云间晴",
      cloudy: "阴",
      fog: "雾",
      rain: "雨",
      snow: "雪",
      storm: "雷暴",
      other: "其他",
    },
    precipLevel: { none: "无降水", light: "小雨", moderate: "中雨", heavy: "大雨" },
    confidence: { high: "高", medium: "中", low: "低" },
    divergenceLead: "检测到各源数据分歧：{list}。",
    divergenceVerify: "请先调用 query_source 逐一核对分歧源的原始快照后再定稿。",
    divergencePrecip: "降水 {wet} 报有雨、{dry} 报无雨",
    divergenceCondition: "天气状况 {groups}",
    divergenceConditionGroup: "{cond}：{sources}",
    divergenceTemperature: "{metric} 源间差距 {spread}°C（{min}~{max}°C）",
    metric: {
      [METRICS.high]: { label: "预测高温", note: "加权集成均值" },
      [METRICS.low]: { label: "预测低温", note: "加权集成均值" },
      [METRICS.highInterval]: {
        label: "高温区间",
        note: "均值 ± 1.28×加权标准差（约80%置信）",
      },
      [METRICS.lowInterval]: {
        label: "低温区间",
        note: "均值 ± 1.28×加权标准差（约80%置信）",
      },
      [METRICS.poP]: { label: "降水概率", note: "报雨源权重之和" },
      [METRICS.precipLevel]: {
        label: "降水等级",
        note: "按加权降水均值分级（无/小/中/大雨）",
      },
      [METRICS.condition]: { label: "天气状况", note: "加权多数投票" },
      [METRICS.wind]: { label: "风力", note: "加权风速换算蒲福风级" },
      [METRICS.humidity]: { label: "湿度", note: "加权平均" },
      [METRICS.confidence]: {
        label: "可信度",
        note: "源之间一致强度（不依赖历史真值）",
      },
      [METRICS.risk]: { label: "风险标记", note: "阈值 + 多源一致" },
    },
    risk: {
      heat: "高温",
      cold: "低温",
      heavyRain: "强降水",
      wind: "大风",
      storm: "雷暴",
      snow: "降雪",
      diurnal: "昼夜温差大",
    },
    riskLevel: { warning: "警告", info: "提醒" },
  },
  en: {
    metricLine: "- {id} ({label}): {value} ※{note}",
    windValue: "Bft {n}",
    weightsSep: ", ",
    riskLine: "- {label} ({level}): {n} source(s) agree",
    riskNone: "(no risk flags)",
    weightsNote:
      "Per-source weights ({weights}): higher weight means the source is more trusted.",
    condition: {
      clear: "Clear",
      partlyCloudy: "Partly cloudy",
      cloudy: "Cloudy",
      fog: "Fog",
      rain: "Rain",
      snow: "Snow",
      storm: "Storm",
      other: "Other",
    },
    precipLevel: {
      none: "No rain",
      light: "Light",
      moderate: "Moderate",
      heavy: "Heavy",
    },
    confidence: { high: "High", medium: "Medium", low: "Low" },
    divergenceLead: "The sources disagree: {list}.",
    divergenceVerify:
      "Call query_source to verify each diverging source's raw snapshot before finalizing.",
    divergencePrecip: "precipitation: {wet} report rain, {dry} report no rain",
    divergenceCondition: "condition: {groups}",
    divergenceConditionGroup: "{cond}: {sources}",
    divergenceTemperature:
      "{metric} spread {spread}°C across sources ({min}~{max}°C)",
    metric: {
      [METRICS.high]: {
        label: "Predicted high",
        note: "weighted ensemble mean",
      },
      [METRICS.low]: { label: "Predicted low", note: "weighted ensemble mean" },
      [METRICS.highInterval]: {
        label: "High range",
        note: "mean ± 1.28× weighted std (≈80% confidence)",
      },
      [METRICS.lowInterval]: {
        label: "Low range",
        note: "mean ± 1.28× weighted std (≈80% confidence)",
      },
      [METRICS.poP]: {
        label: "Precipitation probability",
        note: "sum of weights of rain-reporting sources",
      },
      [METRICS.precipLevel]: {
        label: "Precip level",
        note: "graded by weighted precip mean (none/light/moderate/heavy)",
      },
      [METRICS.condition]: {
        label: "Condition",
        note: "weighted majority vote",
      },
      [METRICS.wind]: {
        label: "Wind",
        note: "weighted wind speed → Beaufort scale",
      },
      [METRICS.humidity]: { label: "Humidity", note: "weighted average" },
      [METRICS.confidence]: {
        label: "Confidence",
        note: "inter-source agreement strength (no historical truth needed)",
      },
      [METRICS.risk]: {
        label: "Risk flags",
        note: "threshold + multi-source agreement",
      },
    },
    risk: {
      heat: "Heat",
      cold: "Cold",
      heavyRain: "Heavy rain",
      wind: "Wind",
      storm: "Storm",
      snow: "Snow",
      diurnal: "Large diurnal range",
    },
    riskLevel: { warning: "warning", info: "info" },
  },
}
