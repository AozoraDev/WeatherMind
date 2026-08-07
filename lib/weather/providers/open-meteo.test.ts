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
