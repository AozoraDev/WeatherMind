import type { SourceInput } from "@/lib/schemas/forecast-agent"
import {
  sourceSchema,
  type ConditionCategory,
  type WeatherSource,
} from "@/lib/schemas/weather"
import { RAIN_THRESHOLD_MM } from "./ensemble"

// 源间分歧检测：纯函数，供 prompt 在用户消息里注入「必须用 query_source 核对」的强制指令。
// 有分歧日模型不能仅凭聚合指标作答 → ReAct 轨迹出现真实工具步骤（工具变成承重墙）。

export type SourceDivergence =
  | { kind: "precip"; wet: WeatherSource[]; dry: WeatherSource[] }
  | {
      kind: "condition"
      groups: { condition: ConditionCategory; sources: WeatherSource[] }[]
    }
  | {
      kind: "temperature"
      metric: "high" | "low"
      spread: number
      min: number
      max: number
    }

// 温差阈值：某源高温/低温的 max-min 达到此值视为源间分歧
const TEMP_SPREAD_C = 3

// 规范顺序：源列表/条件分组按此排序，prompt 输出与测试可复现（单一来源 sourceSchema.options）
const SOURCE_ORDER = sourceSchema.options
const CONDITION_ORDER: ConditionCategory[] = [
  "clear",
  "partlyCloudy",
  "cloudy",
  "fog",
  "rain",
  "snow",
  "storm",
  "other",
]

// 统一保留 1 位小数（与 ensemble.ts round1 同约定），显示值稳定
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// 检测源间分歧：降水分歧（湿/干两组都非空）→ 条件分歧（非 null 类别 > 1 组）→ 温差分歧（high/low 各算）。
// 检测阈值用未取整的原始值判定，spread/min/max 仅在返回时保留 1 位小数，边界判定不受舍入干扰
export function detectSourceDivergences(
  inputs: Record<WeatherSource, SourceInput>
): SourceDivergence[] {
  const divergences: SourceDivergence[] = []

  // 降水分歧：precip >= RAIN_THRESHOLD_MM 归湿组，其余归干组
  const wet: WeatherSource[] = []
  const dry: WeatherSource[] = []
  for (const source of SOURCE_ORDER) {
    const input = inputs[source]
    if (!input) continue
    ;(input.precip >= RAIN_THRESHOLD_MM ? wet : dry).push(source)
  }
  if (wet.length > 0 && dry.length > 0) {
    divergences.push({ kind: "precip", wet, dry })
  }

  // 条件分歧：按非 null 条件类别分组，超过 1 组才算分歧（缺条件的源忽略）
  const conditionGroups = new Map<ConditionCategory, WeatherSource[]>()
  for (const source of SOURCE_ORDER) {
    const condition = inputs[source]?.condition
    if (!condition) continue
    const list = conditionGroups.get(condition)
    if (list) list.push(source)
    else conditionGroups.set(condition, [source])
  }
  if (conditionGroups.size > 1) {
    const groups = [...conditionGroups.entries()]
      .sort(
        (a, b) =>
          CONDITION_ORDER.indexOf(a[0]) - CONDITION_ORDER.indexOf(b[0])
      )
      .map(([condition, sources]) => ({ condition, sources }))
    divergences.push({ kind: "condition", groups })
  }

  // 温差分歧：high/low 各自统计 max-min，有效值 ≥ 2 且 spread ≥ 3 才分歧
  for (const metric of ["high", "low"] as const) {
    const values = SOURCE_ORDER.flatMap((source) => {
      const v = inputs[source]?.[metric]
      return v == null ? [] : [v]
    })
    if (values.length < 2) continue
    const max = Math.max(...values)
    const min = Math.min(...values)
    if (max - min >= TEMP_SPREAD_C) {
      divergences.push({
        kind: "temperature",
        metric,
        spread: round1(max - min),
        min: round1(min),
        max: round1(max),
      })
    }
  }

  return divergences
}
