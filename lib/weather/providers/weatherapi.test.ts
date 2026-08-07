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
})
