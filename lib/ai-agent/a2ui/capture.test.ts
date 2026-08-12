import { describe, expect, it } from "vitest"

import {
  createForecastCardAccumulator,
  reduceToolEvent,
  toForecastCardInput,
} from "./capture"
import type { ForecastCardMetrics } from "./forecast-card"

// 工具观察收集器：验证 query_city 名称收集、success 采纳/覆盖、no-data/error/pending 忽略、
// locale 取名字段、其他工具名不干扰（rules/testing.md 需测纯函数分支）。

// 与 tools.ts forecastRowToObservation 的 metrics 形状一致的完整指标
const metrics: ForecastCardMetrics = {
  predicted_high: 31.2,
  predicted_low: 22.8,
  high_interval: [29, 33],
  low_interval: [21, 25],
  precipitation_probability: 35,
  precip_level: "light",
  condition: "cloudy",
  wind_beaufort: 3,
  humidity: 60,
  confidence: "high",
  risk_flags: [{ type: "heat", level: "warning", sources: 2 }],
}

// 组成功/失败观测结果字符串（工具事件 result 是 JSON 文本）
const success = (cityId: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: "success",
    cityId,
    day: "2026-08-11",
    locale: "zh",
    metrics,
    ...overrides,
  })
const statusJson = (status: string) => JSON.stringify({ status, cityId: "c1", day: "2026-08-11" })

const citiesJson = (cities: unknown) => JSON.stringify({ cities })

describe("reduceToolEvent query_city 名称收集", () => {
  it("zh 取 name_ja、en 取 name_en", () => {
    const zh = createForecastCardAccumulator()
    reduceToolEvent(
      zh,
      {
        name: "query_city",
        result: citiesJson([{ id: "c1", name_ja: "東京", name_en: "Tokyo" }]),
      },
      "zh"
    )
    expect(zh.cityNames.c1).toBe("東京")

    const en = createForecastCardAccumulator()
    reduceToolEvent(
      en,
      {
        name: "query_city",
        result: citiesJson([{ id: "c1", name_ja: "東京", name_en: "Tokyo" }]),
      },
      "en"
    )
    expect(en.cityNames.c1).toBe("Tokyo")
  })

  it("首选字段缺失时回退另一语言", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(
      acc,
      { name: "query_city", result: citiesJson([{ id: "c1", name_ja: "", name_en: "Shanghai" }]) },
      "zh"
    )
    expect(acc.cityNames.c1).toBe("Shanghai")
  })

  it("多城市全部收集", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(
      acc,
      {
        name: "query_city",
        result: citiesJson([
          { id: "c1", name_ja: "東京", name_en: "Tokyo" },
          { id: "c2", name_ja: "大阪", name_en: "Osaka" },
        ]),
      },
      "zh"
    )
    expect(acc.cityNames).toEqual({ c1: "東京", c2: "大阪" })
  })

  it("同名 id 后到覆盖；无 id/解析失败/空数组忽略", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_city", result: citiesJson([{ id: "c1", name_ja: "A", name_en: "" }]) }, "zh")
    reduceToolEvent(acc, { name: "query_city", result: citiesJson([{ id: "c1", name_ja: "B", name_en: "" }]) }, "zh")
    expect(acc.cityNames.c1).toBe("B")
    // 非法 JSON / 缺 cities / 空数组 / 缺 id 均不污染
    reduceToolEvent(acc, { name: "query_city", result: "{bad json" }, "zh")
    reduceToolEvent(acc, { name: "query_city", result: citiesJson(null) }, "zh")
    reduceToolEvent(acc, { name: "query_city", result: citiesJson([]) }, "zh")
    reduceToolEvent(acc, { name: "query_city", result: citiesJson([{ name_ja: "X", name_en: "" }]) }, "zh")
    expect(acc.cityNames.c1).toBe("B")
  })
})

describe("reduceToolEvent 预报采纳", () => {
  it("query_forecast success → 记录 metrics + cityId", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_forecast", result: success("c1") }, "zh")
    expect(acc.forecast).not.toBeNull()
    expect(acc.forecast?.predicted_high).toBe(31.2)
    expect(acc.cityId).toBe("c1")
  })

  it("generate_forecast success 同样采纳", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "generate_forecast", result: success("c2") }, "zh")
    expect(acc.forecast?.condition).toBe("cloudy")
    expect(acc.cityId).toBe("c2")
  })

  it("no-data / error / pending 忽略（forecast 保持 null）", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_forecast", result: statusJson("no-data") }, "zh")
    reduceToolEvent(acc, { name: "query_forecast", result: statusJson("error") }, "zh")
    reduceToolEvent(acc, { name: "query_forecast", result: statusJson("pending") }, "zh")
    expect(acc.forecast).toBeNull()
    expect(acc.cityId).toBeNull()
  })

  it("success 但缺 metrics → 忽略", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_forecast", result: JSON.stringify({ status: "success", cityId: "c1" }) }, "zh")
    expect(acc.forecast).toBeNull()
  })

  it("最新 success 覆盖先前（重复查询取最后一次）", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_forecast", result: success("c1", { metrics: { ...metrics, predicted_high: 25 } }) }, "zh")
    reduceToolEvent(acc, { name: "query_forecast", result: success("c1", { metrics: { ...metrics, predicted_high: 33 } }) }, "zh")
    expect(acc.forecast?.predicted_high).toBe(33)
  })

  it("非法 JSON 忽略", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_forecast", result: "{nope" }, "zh")
    expect(acc.forecast).toBeNull()
  })

  it("其他工具名不影响累积器", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_source", result: "{}" }, "zh")
    reduceToolEvent(acc, { name: "anything_else", result: "{}" }, "zh")
    expect(acc).toEqual({ cityNames: {}, forecast: null, cityId: null })
  })
})

describe("toForecastCardInput", () => {
  it("无成功预报 → null", () => {
    expect(toForecastCardInput(createForecastCardAccumulator())).toBeNull()
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_forecast", result: statusJson("no-data") }, "zh")
    expect(toForecastCardInput(acc)).toBeNull()
  })

  it("有预报 + 已收集城市名 → 解析出显示名", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_city", result: citiesJson([{ id: "c1", name_ja: "東京", name_en: "Tokyo" }]) }, "zh")
    reduceToolEvent(acc, { name: "query_forecast", result: success("c1") }, "zh")
    const input = toForecastCardInput(acc)
    expect(input?.cityName).toBe("東京")
    expect(input?.metrics.predicted_high).toBe(31.2)
  })

  it("cityId 无对应名称 → cityName 为 null（标题兜底）", () => {
    const acc = createForecastCardAccumulator()
    reduceToolEvent(acc, { name: "query_forecast", result: success("unknown-id") }, "zh")
    expect(toForecastCardInput(acc)?.cityName).toBeNull()
  })
})
