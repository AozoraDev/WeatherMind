import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CityPoint } from "@/lib/schemas/weather"

import { weatherApi } from "./weatherapi"

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

// 单日历史响应：adapter 逐天请求，取 forecastday[0].day 的日汇总字段
const historyPayload = {
  forecast: {
    forecastday: [
      {
        day: {
          maxtemp_c: 31.0,
          mintemp_c: 24.5,
          totalprecip_mm: 3.2,
          condition: { text: "Moderate rain", code: 1183 },
        },
      },
    ],
  },
}

describe("weatherApi 历史回填 fetchDailyHistory", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    vi.stubEnv("WEATHERAPI_API_KEY", "test-key")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it("逐天请求 history.json 并映射日汇总", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(historyPayload))
    const result = await weatherApi.fetchDailyHistory(city, 7)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 7 天各一次请求，URL 都带 dt=<本地日期>
    const calls = vi.mocked(fetch).mock.calls
    expect(calls).toHaveLength(7)
    const urls = calls.map(([input]) => String(input))
    for (const url of urls) {
      expect(url).toContain("/history.json")
      expect(url).toMatch(/dt=\d{4}-\d{2}-\d{2}/)
    }
    expect(urls[0]).toContain("dt=2026-08-01")
    expect(urls[6]).toContain("dt=2026-08-07")

    // 逐天映射：day 键按城市本地日、字段取自日汇总、condition 归一
    expect(result.daily.map((d) => d.day)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ])
    const first = result.daily[0]
    expect(first.highTemp).toBe(31.0)
    expect(first.lowTemp).toBe(24.5)
    expect(first.precipitation).toBe(3.2)
    expect(first.conditionCode).toBe(1183)
    expect(first.conditionCategory).toBe("rain")
  })

  it("缺 API key 返回 missingKey，不发请求", async () => {
    vi.stubEnv("WEATHERAPI_API_KEY", "")
    const result = await weatherApi.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "missingKey" })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("单天请求非 2xx 返回 http", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, false))
    const result = await weatherApi.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "http" })
  })

  it("history 响应解析失败返回 parse", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ forecast: {} }))
    const result = await weatherApi.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "parse" })
  })

  it("history 缺 forecastday 返回 noData", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ forecast: { forecastday: [] } })
    )
    const result = await weatherApi.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "noData" })
  })

  it("history 缺 totalprecip_mm 时降水按 0", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        forecast: {
          forecastday: [
            {
              day: {
                maxtemp_c: 31.0,
                mintemp_c: 24.5,
                condition: { text: "Partly cloudy", code: 1003 },
                // 无 totalprecip_mm → 兜底 0
              },
            },
          ],
        },
      })
    )
    const result = await weatherApi.fetchDailyHistory(city, 7)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daily).toHaveLength(7)
    for (const d of result.daily) expect(d.precipitation).toBe(0)
  })
})

describe("weatherApi 实时+预报 fetchCurrentAndForecast", () => {
  const currentPayload = {
    current: {
      last_updated_epoch: 1754442000,
      temp_c: 27.5,
      feelslike_c: 28.5,
      humidity: 65,
      pressure_mb: 1012,
      wind_kph: 14,
      wind_degree: 190,
      precip_mm: 0.5,
      condition: { text: "Partly cloudy", code: 1003 },
    },
  }
  const forecastPayload = {
    forecast: {
      forecastday: [
        {
          hour: [
            {
              time_epoch: 1754445600,
              temp_c: 28.0,
              wind_kph: 18,
              precip_mm: 0,
              condition: { text: "Moderate rain", code: 1183 },
            },
          ],
        },
      ],
    },
  }

  // 按 URL 分发伪响应：/current.json 走实时，其余走预报
  function stubFetchByUrl(
    current: unknown = currentPayload,
    forecast: unknown = forecastPayload
  ) {
    return vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      return url.includes("/current.json")
        ? jsonResponse(current)
        : jsonResponse(forecast)
    })
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    vi.stubEnv("WEATHERAPI_API_KEY", "test-key")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it("成功：两个端点并行请求并归一化", async () => {
    const fetchMock = stubFetchByUrl()
    const result = await weatherApi.fetchCurrentAndForecast(city)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { current, forecast, source } = result.data
    expect(source).toBe("weatherapi")
    expect(current.temperature).toBe(27.5)
    expect(current.windSpeed).toBe(3.89) // 14 km/h → m/s
    expect(current.conditionCode).toBe(1003)
    expect(current.conditionCategory).toBe("partlyCloudy")
    expect(current.observedAt).toBe(new Date(1754442000 * 1000).toISOString())
    expect(forecast).toHaveLength(1)
    expect(forecast[0].conditionCategory).toBe("rain")
    expect(forecast[0].forecastTime).toBe(
      new Date(1754445600 * 1000).toISOString()
    )
    expect(fetchMock.mock.calls).toHaveLength(2)
  })

  it("缺 API key 返回 missingKey，不发请求", async () => {
    vi.stubEnv("WEATHERAPI_API_KEY", "")
    const result = await weatherApi.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "missingKey" })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("current 请求非 2xx 返回 http", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes("/current.json")
        ? jsonResponse({}, false)
        : jsonResponse(forecastPayload)
    )
    const result = await weatherApi.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "http" })
  })

  it("forecast 请求非 2xx 返回 http", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes("/current.json")
        ? jsonResponse(currentPayload)
        : jsonResponse({}, false)
    )
    const result = await weatherApi.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "http" })
  })

  it("current 解析失败返回 parse", async () => {
    stubFetchByUrl({ current: { temp_c: "27" } }, forecastPayload)
    const result = await weatherApi.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "parse" })
  })

  it("forecast 解析失败返回 parse", async () => {
    stubFetchByUrl(currentPayload, { forecast: { forecastday: [{}] } })
    const result = await weatherApi.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "parse" })
  })

  it("current 缺 wind_kph/precip_mm 时兜底 0", async () => {
    stubFetchByUrl(
      {
        current: {
          last_updated_epoch: 1754442000,
          temp_c: 27.5,
          condition: { text: "Partly cloudy", code: 1003 },
          // 无 wind_kph / precip_mm
        },
      },
      forecastPayload
    )
    const result = await weatherApi.fetchCurrentAndForecast(city)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.current.windSpeed).toBe(0)
    expect(result.data.current.precipitation).toBe(0)
  })

  it("forecast 条目缺 wind_kph/precip_mm 时兜底 0", async () => {
    stubFetchByUrl(currentPayload, {
      forecast: {
        forecastday: [
          {
            hour: [
              {
                time_epoch: 1754445600,
                temp_c: 28.0,
                condition: { text: "Partly cloudy", code: 1003 },
                // 无 wind_kph / precip_mm
              },
            ],
          },
        ],
      },
    })
    const result = await weatherApi.fetchCurrentAndForecast(city)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.forecast[0].windSpeed).toBe(0)
    expect(result.data.forecast[0].precipitation).toBe(0)
  })
})
