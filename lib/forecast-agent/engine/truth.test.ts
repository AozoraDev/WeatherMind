import type { SupabaseClient } from "@supabase/supabase-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { daysAgoLocalDateKey } from "@/lib/weather/daily"
import type { HistoryDay } from "@/lib/weather/providers"

import { backfillTruth } from "./truth"

// —— 依赖 mock：providers 注册表（truth 只依赖三源的 fetchDailyHistory）——
const historyMock = vi.hoisted(() => ({
  history: [vi.fn(), vi.fn(), vi.fn()],
}))

vi.mock("@/lib/weather/providers", () => ({
  providers: historyMock.history.map((fetchDailyHistory, i) => ({
    source: ["open-meteo", "openweather", "weatherapi"][i],
    fetchCurrentAndForecast: vi.fn(),
    fetchDailyHistory,
  })),
}))

// 固定系统时间：让「昨天」日期键可预期，且 pruneOldTruth 截止线确定
const NOW = new Date("2026-08-11T12:00:00.000Z")

const cityRow = {
  id: "c1",
  name_ja: "東京",
  name_en: "Tokyo",
  latitude: 35.6762,
  longitude: 139.6503,
  timezone: "Asia/Tokyo",
}

// 构造链式 supabase mock：select 返回 eq、delete 返回 lt，末端都 resolve 桩数据
function fakeSupabase() {
  const eq = vi.fn()
  const lt = vi.fn()
  const select = vi.fn(() => ({ eq }))
  const del = vi.fn(() => ({ lt }))
  const upsert = vi.fn()
  const from = vi.fn(() => ({ select, delete: del, upsert }))
  return { from, select, eq, del, lt, upsert }
}

function day(yesterday: string, overrides?: Partial<HistoryDay>): HistoryDay {
  return {
    day: yesterday,
    highTemp: 20,
    lowTemp: 10,
    precipitation: 0.5,
    conditionCode: 800,
    conditionLabel: "Clear",
    conditionCategory: "clear",
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  historyMock.history.forEach((h) => h.mockReset())
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("backfillTruth", () => {
  it("多源各取昨天观测，取中位数 upsert；返回城市数与落库行数", async () => {
    const { from, eq, upsert, lt } = fakeSupabase()
    eq.mockResolvedValue({ data: [cityRow], error: null })
    upsert.mockResolvedValue({ error: null })
    lt.mockResolvedValue({ error: null })

    const yesterday = daysAgoLocalDateKey("Asia/Tokyo", 1)
    // 三源昨天观测：高/低/降水取中位数后落库
    historyMock.history[0].mockResolvedValue({
      ok: true,
      daily: [day(yesterday, { highTemp: 20, lowTemp: 10, precipitation: 0.5 })],
    })
    historyMock.history[1].mockResolvedValue({
      ok: true,
      daily: [day(yesterday, { highTemp: 22, lowTemp: 12, precipitation: 0.3 })],
    })
    historyMock.history[2].mockResolvedValue({
      ok: true,
      daily: [day(yesterday, { highTemp: 24, lowTemp: 14, precipitation: 0.7 })],
    })

    const result = await backfillTruth({ from } as unknown as SupabaseClient)

    expect(result).toEqual({ cities: 1, rows: 1 })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        city_id: "c1",
        day: yesterday,
        observed_high: 22,
        observed_low: 12,
        observed_precip: 0.5,
        sources_used: 3,
      }),
      { onConflict: "city_id,day" }
    )
  })

  it("某源拉取失败或缺昨天那天的数据 → 该源缺席，仍按剩余源取中位数", async () => {
    const { from, eq, upsert, lt } = fakeSupabase()
    eq.mockResolvedValue({ data: [cityRow], error: null })
    upsert.mockResolvedValue({ error: null })
    lt.mockResolvedValue({ error: null })

    const yesterday = daysAgoLocalDateKey("Asia/Tokyo", 1)
    historyMock.history[0].mockResolvedValue({ ok: true, daily: [day(yesterday, { highTemp: 18, lowTemp: 8, precipitation: 0.2 })] })
    historyMock.history[1].mockResolvedValue({ ok: false, error: "network" })
    // 第三个源返回了数据但缺「昨天」那天（只回填到前前天）
    historyMock.history[2].mockResolvedValue({
      ok: true,
      daily: [day(daysAgoLocalDateKey("Asia/Tokyo", 2), { highTemp: 30, lowTemp: 20, precipitation: 3 })]
    })

    await backfillTruth({ from } as unknown as SupabaseClient)

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        observed_high: 18,
        observed_low: 8,
        observed_precip: 0.2,
        sources_used: 1,
      }),
      expect.anything()
    )
  })

  it("所有源都拿不到昨天观测 → 跳过该城，不 upsert 真值", async () => {
    const { from, eq, upsert, lt } = fakeSupabase()
    eq.mockResolvedValue({ data: [cityRow], error: null })
    lt.mockResolvedValue({ error: null })
    historyMock.history[0].mockResolvedValue({ ok: false, error: "http" })
    historyMock.history[1].mockResolvedValue({ ok: false, error: "network" })
    historyMock.history[2].mockResolvedValue({ ok: false, error: "noData" })

    const result = await backfillTruth({ from } as unknown as SupabaseClient)

    expect(result).toEqual({ cities: 1, rows: 0 })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("cities 查询失败 → 直接返回 0 城 0 行，不触任何 provider", async () => {
    const { from, eq } = fakeSupabase()
    eq.mockResolvedValue({ data: null, error: { message: "boom" } })

    const result = await backfillTruth({ from } as unknown as SupabaseClient)

    expect(result).toEqual({ cities: 0, rows: 0 })
    expect(historyMock.history[0]).not.toHaveBeenCalled()
  })

  it("upsert 失败 → 该城不计入 rows", async () => {
    const { from, eq, upsert, lt } = fakeSupabase()
    eq.mockResolvedValue({ data: [cityRow], error: null })
    upsert.mockResolvedValue({ error: { message: "fk" } })
    lt.mockResolvedValue({ error: null })

    const yesterday = daysAgoLocalDateKey("Asia/Tokyo", 1)
    historyMock.history[0].mockResolvedValue({ ok: true, daily: [day(yesterday)] })
    historyMock.history[1].mockResolvedValue({ ok: false, error: "network" })
    historyMock.history[2].mockResolvedValue({ ok: false, error: "noData" })

    const result = await backfillTruth({ from } as unknown as SupabaseClient)

    expect(result).toEqual({ cities: 1, rows: 0 })
  })

  it("真值轮换：删掉超窗旧行，截止线按东京日前 31 天", async () => {
    const { from, eq, lt } = fakeSupabase()
    eq.mockResolvedValue({ data: [], error: null })
    lt.mockResolvedValue({ error: null })

    await backfillTruth({ from } as unknown as SupabaseClient)

    expect(lt).toHaveBeenCalledWith(
      "day",
      daysAgoLocalDateKey("Asia/Tokyo", 31)
    )
  })

  it("真值轮换删除失败 → 仅记日志，不阻断主流程", async () => {
    const { from, eq, lt } = fakeSupabase()
    eq.mockResolvedValue({ data: [], error: null })
    lt.mockResolvedValue({ error: { message: "perm" } })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    await backfillTruth({ from } as unknown as SupabaseClient)

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("weather_truth 轮换删除失败")
    )
    spy.mockRestore()
  })
})
