import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CityPoint } from "@/lib/schemas/weather"

import { openMeteo } from "./open-meteo"

const city: CityPoint = {
  id: "c1",
  nameJa: "東京",
  nameEn: "Tokyo",
  latitude: 35.6762,
  longitude: 139.6503,
  timezone: "Asia/Tokyo",
}

// 构造伪 fetch 响应：只暴露 adapter 用到的 ok + json 两个成员
function jsonResponse(json: unknown, ok = true) {
  return { ok, json: async () => json } as Response
}

// 逐小时载荷：naive 本地时间（JST）覆盖 窗口内两天 + 一天未来（应被过滤）；
// weather_code 用 WMO 码：0 晴、3 阴、61 雨、1 多云间晴
const hourlyPayload = {
  utc_offset_seconds: 32400,
  hourly: {
    time: [
      "2026-08-01T00:00",
      "2026-08-01T12:00",
      "2026-08-07T12:00",
      "2026-08-08T00:00",
    ],
    temperature_2m: [24, 30, 28, 26],
    wind_speed_10m: [2, 3, 4, 3],
    weather_code: [0, 3, 61, 1],
    precipitation: [0, 0, 2.0, 0],
  },
}

describe("openMeteo 历史回填 fetchDailyHistory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    // 冻结时钟：回填窗口按固定「今天」计算，结果确定
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("请求带 past_days，仅返回窗口内（含今天）的日聚合", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(hourlyPayload))
    const result = await openMeteo.fetchDailyHistory(city, 7)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // past_days 参数随请求带上
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain("past_days=7")

    // 聚合窗口内两天（08-01、08-07）；未来天 08-08 被过滤
    expect(result.daily.map((d) => d.day).sort()).toEqual([
      "2026-08-01",
      "2026-08-07",
    ])
    const day1 = result.daily.find((d) => d.day === "2026-08-01")!
    expect(day1.highTemp).toBe(30)
    expect(day1.lowTemp).toBe(24)
    // 代表天气取最高温 slot：12:00 的 code 3（Overcast）→ 粗分 partlyCloudy
    expect(day1.conditionCategory).toBe("partlyCloudy")
    const today = result.daily.find((d) => d.day === "2026-08-07")!
    expect(today.precipitation).toBe(2.0)
    expect(today.conditionCategory).toBe("rain")
  })

  it("响应缺 hourly 返回 noData", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ utc_offset_seconds: 32400 })
    )
    const result = await openMeteo.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "noData" })
  })
})

describe("openMeteo 实时+预报 fetchCurrentAndForecast", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // current 缺计算值字段时省略，此处给足；naive 时间为 JST（offset 32400）
  const currentPayload = {
    utc_offset_seconds: 32400,
    current: {
      time: "2026-08-07T12:00",
      temperature_2m: 28,
      relative_humidity_2m: 60,
      apparent_temperature: 29.5,
      precipitation: 0.2,
      weather_code: 1,
      pressure_msl: 1013,
      wind_speed_10m: 4,
      wind_direction_10m: 200,
    },
    hourly: {
      time: ["2026-08-07T13:00"],
      temperature_2m: [28],
      wind_speed_10m: [4],
      weather_code: [1],
      precipitation: [0],
    },
  }

  it("成功：current 与 hourly 归一化，naive 时间换算成 UTC", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(currentPayload))
    const result = await openMeteo.fetchCurrentAndForecast(city)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { current, forecast, source } = result.data
    expect(source).toBe("open-meteo")
    expect(current.temperature).toBe(28)
    expect(current.windSpeed).toBe(4)
    expect(current.precipitation).toBe(0.2)
    expect(current.conditionCode).toBe(1)
    expect(current.conditionCategory).toBe("partlyCloudy")
    // JST 12:00 → UTC 03:00（减 9h 偏移）
    expect(current.observedAt).toBe("2026-08-07T03:00:00.000Z")
    expect(forecast).toHaveLength(1)
    expect(forecast[0].forecastTime).toBe("2026-08-07T04:00:00.000Z")
  })

  it("响应缺 current 返回 noData", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ utc_offset_seconds: 32400 })
    )
    const result = await openMeteo.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "noData" })
  })

  it("current 缺必需字段（温度）返回 noData", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        utc_offset_seconds: 32400,
        current: { time: "2026-08-07T12:00" },
      })
    )
    const result = await openMeteo.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "noData" })
  })

  it("字段类型漂移（温度变字符串）返回 parse", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        utc_offset_seconds: 32400,
        current: {
          time: "2026-08-07T12:00",
          temperature_2m: "28",
          wind_speed_10m: 4,
          weather_code: 1,
        },
      })
    )
    const result = await openMeteo.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "parse" })
  })

  it("非 2xx 返回 http", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, false))
    const result = await openMeteo.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "http" })
  })

  it("网络异常返回 network", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"))
    const result = await openMeteo.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "network" })
  })

  it("缺 hourly 时 forecast 为空但整体成功", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        utc_offset_seconds: 32400,
        current: currentPayload.current,
      })
    )
    const result = await openMeteo.fetchCurrentAndForecast(city)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.forecast).toEqual([])
  })
})
