import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CityPoint } from "@/lib/schemas/weather"

import { openWeather } from "./openweather"

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

// 合法实时载荷（main 必填，weather 至少一项）
const currentPayload = {
  dt: 1754438400,
  main: { temp: 25.3, feels_like: 26.1, humidity: 60, pressure: 1013 },
  wind: { speed: 3.5, deg: 180 },
  weather: [{ id: 800, main: "Clear", description: "clear sky" }],
}

// 合法预报载荷：第一条带 3h 降水，第二条缺湿度/气压（optional 字段）
const forecastPayload = {
  list: [
    {
      dt: 1754467200,
      main: { temp: 26.0, feels_like: 27.0, humidity: 58, pressure: 1012 },
      wind: { speed: 4.0, deg: 200 },
      weather: [{ id: 801, main: "Clouds", description: "few clouds" }],
      rain: { "3h": 1.2 },
    },
    {
      dt: 1754478000,
      main: { temp: 25.0 },
      wind: { speed: 3.0 },
      weather: [{ id: 500, main: "Rain", description: "light rain" }],
    },
  ],
}

// 按 URL 分发伪响应：/weather 走实时，其余走预报
// 载荷视为不可信输入（unknown），由适配器内 Zod safeParse 兜底校验
function stubFetchByUrl(
  current: unknown = currentPayload,
  forecast: unknown = forecastPayload
) {
  const fetchMock = vi.mocked(fetch)
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes("/weather")) return jsonResponse(current)
    return jsonResponse(forecast)
  })
  return fetchMock
}

describe("openWeather 适配器", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    vi.stubEnv("OPENWEATHER_API_KEY", "test-key")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("缺 API key 返回 missingKey，不发请求", async () => {
    vi.stubEnv("OPENWEATHER_API_KEY", "")
    const result = await openWeather.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "missingKey" })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("非 2xx 返回 http", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ message: "bad key" }, false)
    )
    const result = await openWeather.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "http" })
  })

  it("网络异常返回 network", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"))
    const result = await openWeather.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "network" })
  })

  it("响应缺 main 字段返回 parse", async () => {
    stubFetchByUrl({ dt: 1754438400 }, forecastPayload)
    const result = await openWeather.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "parse" })
  })

  it("合法载荷归一化正确，且请求禁用缓存", async () => {
    const fetchMock = stubFetchByUrl()
    const result = await openWeather.fetchCurrentAndForecast(city)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { current, forecast, source } = result.data
    expect(source).toBe("openweather")

    // 实时：温度透传、条件码与分类、无降水按 0
    expect(current.temperature).toBe(25.3)
    expect(current.conditionCode).toBe(800)
    expect(current.conditionCategory).toBe("clear")
    expect(current.precipitation).toBe(0)
    expect(current.observedAt).toBe(new Date(1754438400 * 1000).toISOString())

    // 预报：两条、降水取自 rain["3h"]、forecastTime 由 dt 推导
    expect(forecast).toHaveLength(2)
    expect(forecast[0].precipitation).toBe(1.2)
    expect(forecast[0].forecastTime).toBe(
      new Date(1754467200 * 1000).toISOString()
    )
    expect(forecast[1].conditionCategory).toBe("rain")

    // 两个端点都带 cache: no-store（防 Next 上游缓存返回旧天气）
    const calls = fetchMock.mock.calls
    expect(calls).toHaveLength(2)
    for (const [, init] of calls) expect(init?.cache).toBe("no-store")
  })

  it("current 缺 weather/wind 时兜底（code -1、风速 0、Unknown）", async () => {
    stubFetchByUrl({ dt: 1754438400, main: { temp: 25.3 } }, forecastPayload)
    const result = await openWeather.fetchCurrentAndForecast(city)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { current } = result.data
    expect(current.conditionCode).toBe(-1)
    expect(current.conditionCategory).toBe("other")
    expect(current.conditionLabel).toBe("Unknown")
    expect(current.windSpeed).toBe(0)
    expect(current.precipitation).toBe(0)
  })

  it("forecast 条目缺 weather/wind 时兜底（code -1、风速 0）", async () => {
    stubFetchByUrl(currentPayload, {
      list: [{ dt: 1754467200, main: { temp: 26.0 } }],
    })
    const result = await openWeather.fetchCurrentAndForecast(city)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const item = result.data.forecast[0]
    expect(item.conditionCode).toBe(-1)
    expect(item.conditionLabel).toBe("Unknown")
    expect(item.conditionCategory).toBe("other")
    expect(item.windSpeed).toBe(0)
    expect(item.precipitation).toBe(0)
  })

  it("forecast 请求非 2xx 返回 http", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes("/weather")
        ? jsonResponse(currentPayload)
        : jsonResponse({}, false)
    )
    const result = await openWeather.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "http" })
  })

  it("forecast 解析失败返回 parse", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input) =>
        String(input).includes("/weather")
          ? jsonResponse(currentPayload)
          : jsonResponse({ list: [{ dt: "x" }] }) // 缺 main 字段触发 schema 失败
    )
    const result = await openWeather.fetchCurrentAndForecast(city)
    expect(result).toEqual({ ok: false, error: "parse" })
  })
})

describe("openWeather 历史回填 fetchDailyHistory", () => {
  // 单日 day_summary 响应：min/max 温、降水累计；不含天气状况
  const daySummaryPayload = {
    date: "2026-08-01",
    temperature: { min: 22.0, max: 29.5 },
    precipitation: { total: 5.1 },
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    vi.stubEnv("OPENWEATHER_API_KEY", "test-key")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it("逐天请求 day_summary，映射高低温/降水，条件列置 null", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(daySummaryPayload))
    const result = await openWeather.fetchDailyHistory(city, 7)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 7 天各一次请求，URL 指向 One Call 3.0 day_summary 且带 date=<本地日期>
    const calls = vi.mocked(fetch).mock.calls
    expect(calls).toHaveLength(7)
    const urls = calls.map(([input]) => String(input))
    for (const url of urls) {
      expect(url).toContain("/onecall/day_summary")
      expect(url).toMatch(/date=\d{4}-\d{2}-\d{2}/)
    }
    expect(urls[0]).toContain("date=2026-08-01")
    expect(urls[6]).toContain("date=2026-08-07")

    expect(result.daily).toHaveLength(7)
    expect(result.daily[0]).toEqual({
      day: "2026-08-01",
      highTemp: 29.5,
      lowTemp: 22.0,
      precipitation: 5.1,
      conditionCode: null,
      conditionLabel: null,
      conditionCategory: null,
    })
  })

  it("缺 API key 返回 missingKey，不发请求", async () => {
    vi.stubEnv("OPENWEATHER_API_KEY", "")
    const result = await openWeather.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "missingKey" })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("单天请求非 2xx 返回 http", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, false))
    const result = await openWeather.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "http" })
  })

  it("day_summary 解析失败返回 parse", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ date: "2026-08-01", temperature: { min: "22" } })
    )
    const result = await openWeather.fetchDailyHistory(city, 7)
    expect(result).toEqual({ ok: false, error: "parse" })
  })

  it("day_summary 缺 precipitation 时降水按 0", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        date: "2026-08-01",
        temperature: { min: 22.0, max: 29.5 },
        // 无 precipitation 字段 → 兜底 0
      })
    )
    const result = await openWeather.fetchDailyHistory(city, 7)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.daily).toHaveLength(7)
    for (const d of result.daily) expect(d.precipitation).toBe(0)
  })
})
