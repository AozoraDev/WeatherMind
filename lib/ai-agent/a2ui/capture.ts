import type {
  ForecastCardInput,
  ForecastCardMetrics,
} from "./forecast-card"

// 主 Agent 流式循环里，把工具事件中的「城市名 + 预报观察」累积成卡片输入。
// 只在 query_city 记 id→显示名映射（按 locale 取 name_ja/name_en）、
// query_forecast/generate_forecast 返回 success 时记最新一次指标；其余工具/失败/中间态忽略。
// 数值只回读工具的权威观察，不做任何计算或改写（与「先算后讲」铁律一致）。
// 纯函数、无副作用（reduceToolEvent 原地修改传入的 acc），便于单测与在路由里增量调用。

export type ForecastCardAccumulator = {
  // cityId → 显示名（query_city 结果按 locale 预选好字段）
  cityNames: Record<string, string>
  // 最近一次成功预报观察（重复查询时后到者覆盖）
  forecast: ForecastCardMetrics | null
  // 该观察的城市 id（定位显示名用，取不到则标题用兜底文案）
  cityId: string | null
}

export function createForecastCardAccumulator(): ForecastCardAccumulator {
  return { cityNames: {}, forecast: null, cityId: null }
}

// 工具事件的最小结构（与 react-stream 的 tool 事件同构，不依赖具体类型以便单测）
type ToolEventLike = { name: string; result: string }

export function reduceToolEvent(
  acc: ForecastCardAccumulator,
  ev: ToolEventLike,
  locale: "zh" | "en"
): void {
  if (ev.name === "query_city") {
    const cities = parseCityResult(ev.result)
    if (!cities) return
    for (const c of cities) {
      // 优先 locale 对应名称，缺失时回退另一语言，仍为空则留给标题兜底
      const display = locale === "zh" ? c.name_ja || c.name_en : c.name_en || c.name_ja
      if (display) acc.cityNames[c.id] = display
    }
    return
  }
  if (ev.name === "query_forecast" || ev.name === "generate_forecast") {
    const parsed = parseForecastResult(ev.result)
    if (parsed) {
      acc.forecast = parsed.metrics
      acc.cityId = parsed.cityId
    }
  }
}

// 累积完成后转卡片输入；无成功预报观察（没查到数据/生成失败）返回 null，调用方不发卡片
export function toForecastCardInput(
  acc: ForecastCardAccumulator
): ForecastCardInput | null {
  if (!acc.forecast) return null
  const name = acc.cityId ? acc.cityNames[acc.cityId] : undefined
  return { cityName: name ? name : null, metrics: acc.forecast }
}

// —— 结果解析：工具返回 JSON 字符串，属防御性解析（来源是自家工具，轻量结构校验即可） ——

type CityHit = { id: string; name_ja: string; name_en: string }

// query_city 结果 { cities: [{id,name_ja,name_en,...}] }；解析失败/空数组返回 null
function parseCityResult(result: string): CityHit[] | null {
  try {
    const data = JSON.parse(result) as unknown
    if (!data || typeof data !== "object" || !("cities" in data)) return null
    const cities = (data as { cities: unknown }).cities
    if (!Array.isArray(cities)) return null
    const hits: CityHit[] = []
    for (const item of cities) {
      if (!item || typeof item !== "object") continue
      const { id, name_ja, name_en } = item as Record<string, unknown>
      if (typeof id !== "string") continue
      hits.push({
        id,
        name_ja: typeof name_ja === "string" ? name_ja : "",
        name_en: typeof name_en === "string" ? name_en : "",
      })
    }
    return hits.length > 0 ? hits : null
  } catch {
    return null
  }
}

type ParsedForecast = { cityId: string; metrics: ForecastCardMetrics }

// 预报观察结果：仅 status==="success" 且带 metrics 才采纳；其余状态（no-data/error/pending）忽略
function parseForecastResult(result: string): ParsedForecast | null {
  try {
    const data = JSON.parse(result) as unknown
    if (!data || typeof data !== "object") return null
    const obj = data as Record<string, unknown>
    if (obj.status !== "success") return null
    if (!obj.metrics || typeof obj.metrics !== "object") return null
    return {
      cityId: typeof obj.cityId === "string" ? obj.cityId : "",
      metrics: obj.metrics as ForecastCardMetrics,
    }
  } catch {
    return null
  }
}
