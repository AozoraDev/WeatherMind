import { describe, expect, it } from "vitest"

import type { ForecastItem, WeatherPoint } from "@/lib/schemas/weather"
import {
  aggregateDailyForecast,
  daysAgoLocalDateKey,
  toLocalDateKey,
  todayAggregate,
} from "./daily"

// 构造预报项的最小辅助：默认晴、零降水，测试聚焦温度与时刻
function mk(
  forecastTime: string,
  temperature: number,
  extra?: Partial<
    Pick<
      ForecastItem,
      "precipitation" | "conditionCode" | "conditionLabel" | "conditionCategory"
    >
  >
): ForecastItem {
  return {
    forecastTime,
    temperature,
    precipitation: 0,
    conditionCode: 0,
    conditionLabel: "Sunny",
    conditionCategory: "clear",
    windSpeed: 1,
    observedAt: forecastTime,
    ...extra,
  }
}

describe("toLocalDateKey（UTC ISO → 时区本地日期键）", () => {
  it("跨午夜：UTC 15:00 → JST 次日（+9h 核心回归）", () => {
    expect(toLocalDateKey("2026-08-06T15:00:00Z", "Asia/Tokyo")).toBe(
      "2026-08-07"
    )
  })
  it("同日：UTC 05:00 → JST 当天", () => {
    expect(toLocalDateKey("2026-08-06T05:00:00Z", "Asia/Tokyo")).toBe(
      "2026-08-06"
    )
  })
  it("负偏移时区：UTC 07:00 → 洛杉矶当天（UTC-7）", () => {
    expect(toLocalDateKey("2026-08-06T07:00:00Z", "America/Los_Angeles")).toBe(
      "2026-08-06"
    )
  })
  it("负偏移时区跨日：UTC 01:00 → 洛杉矶前一天（前一日 18:00）", () => {
    expect(toLocalDateKey("2026-08-06T01:00:00Z", "America/Los_Angeles")).toBe(
      "2026-08-05"
    )
  })
  it("整点边界：JST 23:59:59 当天、24:00 次日", () => {
    expect(toLocalDateKey("2026-08-06T14:59:59Z", "Asia/Tokyo")).toBe(
      "2026-08-06"
    )
    expect(toLocalDateKey("2026-08-06T15:00:00Z", "Asia/Tokyo")).toBe(
      "2026-08-07"
    )
  })
})

describe("aggregateDailyForecast（按城市本地日分桶聚合）", () => {
  it("空预报返回空 Map", () => {
    expect(aggregateDailyForecast("Asia/Tokyo", []).size).toBe(0)
  })
  it("单日多 slot：聚合最高/最低/降水，代表天气取最高温 slot", () => {
    const map = aggregateDailyForecast("Asia/Tokyo", [
      mk("2026-08-06T02:00:00Z", 28, {
        precipitation: 1.0,
        conditionCode: 0,
        conditionLabel: "Sunny",
        conditionCategory: "clear",
      }),
      mk("2026-08-06T06:00:00Z", 25, {
        precipitation: 0.5,
        conditionCode: 3,
        conditionLabel: "Rain",
        conditionCategory: "rain",
      }),
    ])
    const agg = map.get("2026-08-06")
    expect(agg).toBeDefined()
    expect(agg!.highTemp).toBe(28)
    expect(agg!.lowTemp).toBe(25)
    expect(agg!.precipitation).toBeCloseTo(1.5)
    expect(agg!.conditionCode).toBe(0)
    expect(agg!.conditionLabel).toBe("Sunny")
    expect(agg!.conditionCategory).toBe("clear")
  })
  it("跨午夜分桶：JST 00:00 与 14:00 并桶为同一天，另一天独立成桶", () => {
    const map = aggregateDailyForecast("Asia/Tokyo", [
      mk("2026-08-05T15:00:00Z", 26), // → JST 08-06 00:00
      mk("2026-08-06T05:00:00Z", 30), // → JST 08-06 14:00
      mk("2026-08-05T05:00:00Z", 22), // → JST 08-05 14:00
    ])
    expect([...map.keys()].sort()).toEqual(["2026-08-05", "2026-08-06"])
    expect(map.get("2026-08-06")!.highTemp).toBe(30)
    expect(map.get("2026-08-06")!.lowTemp).toBe(26)
  })
  it("温度并列：代表天气保留先出现者", () => {
    const map = aggregateDailyForecast("Asia/Tokyo", [
      mk("2026-08-06T02:00:00Z", 28, {
        conditionCode: 0,
        conditionLabel: "Sunny",
        conditionCategory: "clear",
      }),
      mk("2026-08-06T06:00:00Z", 28, {
        conditionCode: 3,
        conditionLabel: "Rain",
        conditionCategory: "rain",
      }),
    ])
    const agg = map.get("2026-08-06")!
    expect(agg.conditionCode).toBe(0)
    expect(agg.conditionCategory).toBe("clear")
  })
  it("预报不含今日：Map 键只含预报覆盖的那一天", () => {
    const map = aggregateDailyForecast("Asia/Tokyo", [
      mk("2026-08-07T02:00:00Z", 29),
    ])
    expect([...map.keys()]).toEqual(["2026-08-07"])
    expect(map.has("2026-08-06")).toBe(false)
  })
})

describe("todayAggregate（当日快照聚合，预报缺当天 slot 时兜底）", () => {
  // 实时数据兜底基准：fetchedAt 14:30 UTC = JST 当天 23:30，today = 2026-08-06
  const fetchedAt = "2026-08-06T14:30:00Z"
  const current: WeatherPoint = {
    temperature: 28.9,
    humidity: 60,
    windSpeed: 3.5,
    precipitation: 0.5,
    conditionCode: 500,
    conditionLabel: "Light rain",
    conditionCategory: "rain",
    observedAt: "2026-08-06T14:36:00Z",
  }

  it("预报含当天 slot：用预报聚合，不动用兜底", () => {
    const agg = todayAggregate("Asia/Tokyo", fetchedAt, [
      mk("2026-08-06T02:00:00Z", 25),
      mk("2026-08-06T06:00:00Z", 32, {
        conditionCode: 800,
        conditionLabel: "Clear",
        conditionCategory: "clear",
      }),
    ], current)
    expect(agg).toEqual({
      day: "2026-08-06",
      highTemp: 32,
      lowTemp: 25,
      precipitation: 0,
      conditionCode: 800,
      conditionLabel: "Clear",
      conditionCategory: "clear",
    })
  })

  it("预报缺当天 slot（OWM 午夜边界）：回退实时数据，high=low=当前温度", () => {
    // 15:00 UTC = JST 次日 00:00，预报只覆盖次日，当天无 slot
    const agg = todayAggregate("Asia/Tokyo", fetchedAt, [
      mk("2026-08-06T15:00:00Z", 28),
    ], current)
    expect(agg).toEqual({
      day: "2026-08-06",
      highTemp: current.temperature,
      lowTemp: current.temperature,
      precipitation: current.precipitation,
      conditionCode: current.conditionCode,
      conditionLabel: current.conditionLabel,
      conditionCategory: current.conditionCategory,
    })
  })

  it("空预报：同样回退实时数据", () => {
    const agg = todayAggregate("Asia/Tokyo", fetchedAt, [], current)
    expect(agg.day).toBe("2026-08-06")
    expect(agg.highTemp).toBe(current.temperature)
    expect(agg.conditionCategory).toBe("rain")
  })
})

describe("daysAgoLocalDateKey（往前 N 天，跨月边界）", () => {
  it("8 月 2 日往前 6 天跨月到 7 月", () => {
    expect(
      daysAgoLocalDateKey("Asia/Tokyo", 6, new Date("2026-08-02T00:00:00Z"))
    ).toBe("2026-07-27")
  })
})
