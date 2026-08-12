import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

vi.mock("@/lib/forecast-agent/db/db", () => ({
  readForecastForCity: vi.fn(),
}))
vi.mock("@/lib/forecast-agent/stream/stream", () => ({
  runForecastAgentStream: vi.fn(),
}))

import { readForecastForCity } from "@/lib/forecast-agent/db/db"
import { runForecastAgentStream } from "@/lib/forecast-agent/stream/stream"
import type { ForecastDbRow } from "@/lib/schemas/forecast-agent"
import { daysAgoLocalDateKey, toLocalDateKey } from "@/lib/weather/daily"

import { buildMainAgentTools, type MainAgentToolContext } from "./tools"

// 与 prompt.test.ts 同构：一条确定的成功行，供 query_forecast / generate_forecast 观察断言
const CITY_ID = "a5e6a111-6b61-4e0f-91c2-5f2f3e4a5b6c"
const SUCCESS_ROW: ForecastDbRow = {
  id: "row-1",
  city_id: CITY_ID,
  day: "2026-08-11",
  locale: "zh",
  status: "success",
  predicted_high: 33.5,
  predicted_low: 24,
  high_interval: [31.5, 35.5],
  low_interval: [22, 26],
  precipitation_probability: 10,
  precip_level: "none",
  condition: "clear",
  wind_beaufort: 3,
  wind_speed: 5.2,
  humidity: 65,
  confidence: "medium",
  risk_flags: [],
  weights: {},
  source_inputs: null,
  formula_version: "v1",
  summary: null,
  points: null,
  advice: null,
  model: "m",
  prompt_tokens: 100,
  completion_tokens: 50,
  error_code: null,
  failed_at: null,
  created_by: "a@b.com",
  created_at: "2026-08-11T00:00:00Z",
  updated_at: "2026-08-11T00:00:00Z",
  react_trace: null,
  markdown_body: "## 推理过程\n…\n## 预报\n…",
}

// 事件数组 → async generator（runForecastAgentStream 的 mock 返回值）
async function* genFrom<T>(events: T[]): AsyncGenerator<T> {
  for (const e of events) yield e
}

// cities 查询链式桩：from → select → or → eq → limit（query_city 唯一使用 session 的路径）
function mockSession(
  rows: unknown[] = [],
  error: unknown = null
): {
  session: SupabaseClient
  or: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  limit: ReturnType<typeof vi.fn>
  from: ReturnType<typeof vi.fn>
} {
  const limit = vi.fn().mockResolvedValue({ data: rows, error })
  const eq = vi.fn(() => ({ limit }))
  const or = vi.fn(() => ({ eq }))
  const select = vi.fn(() => ({ or }))
  const from = vi.fn(() => ({ select }))
  return { session: { from } as unknown as SupabaseClient, or, eq, limit, from }
}

// query_sources 查询链式桩：cities（select→eq→eq→maybeSingle）+ weather_daily（select→eq→eq）。
// 按表名分流：cities 返回定位链，weather_daily 返回每日快照链（末次 eq 直接 resolve 终态）
function mockSourceSession(opts: {
  city?: unknown
  cityError?: unknown
  daily: unknown[]
  dailyError?: unknown
}): {
  session: SupabaseClient
  from: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
} {
  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: opts.city ?? null, error: opts.cityError ?? null })
  const cityEq2 = vi.fn(() => ({ maybeSingle }))
  const cityEq = vi.fn(() => ({ eq: cityEq2 }))
  const citySelect = vi.fn(() => ({ eq: cityEq }))
  const dailyResolve = vi
    .fn()
    .mockResolvedValue({ data: opts.daily, error: opts.dailyError ?? null })
  const dailyEq2 = vi.fn(() => dailyResolve())
  const dailyEq = vi.fn(() => ({ eq: dailyEq2 }))
  const dailySelect = vi.fn(() => ({ eq: dailyEq }))
  const from = vi.fn((table: string) =>
    table === "weather_daily" ? { select: dailySelect } : { select: citySelect }
  )
  return { session: { from } as unknown as SupabaseClient, from, maybeSingle }
}

// query_weather_history 查询链式桩：cities（select→eq→eq→maybeSingle）+ weather_daily
// （select→eq→gte→lte→order(day)→order(source)，末次 order 直接 resolve 终态）
function mockHistorySession(opts: {
  city?: unknown
  cityError?: unknown
  rows?: unknown[]
  rowsError?: unknown
}): {
  session: SupabaseClient
  from: ReturnType<typeof vi.fn>
  gte: ReturnType<typeof vi.fn>
  lte: ReturnType<typeof vi.fn>
} {
  const cityMaybeSingle = vi.fn().mockResolvedValue({
    data: opts.city ?? null,
    error: opts.cityError ?? null,
  })
  const cityEq2 = vi.fn(() => ({ maybeSingle: cityMaybeSingle }))
  const cityEq = vi.fn(() => ({ eq: cityEq2 }))
  const citySelect = vi.fn(() => ({ eq: cityEq }))
  // data 不在这里兜底：null/undefined 原样透传，让工具内的 `data ?? []` 分支被真实走到
  const orderSource = vi
    .fn()
    .mockResolvedValue({ data: opts.rows, error: opts.rowsError ?? null })
  const orderDay = vi.fn(() => ({ order: orderSource }))
  const lte = vi.fn(() => ({ order: orderDay }))
  const gte = vi.fn(() => ({ lte }))
  const dailyEq = vi.fn(() => ({ gte }))
  const dailySelect = vi.fn(() => ({ eq: dailyEq }))
  const from = vi.fn((table: string) =>
    table === "weather_daily" ? { select: dailySelect } : { select: citySelect }
  )
  return { session: { from } as unknown as SupabaseClient, from, gte, lte }
}

function buildCtx(
  overrides?: Partial<MainAgentToolContext>
): MainAgentToolContext {
  return {
    session: mockSession().session,
    service: {} as unknown as SupabaseClient,
    email: "a@b.com",
    model: { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
    locale: "zh",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("query_city", () => {
  it("非法参数（空白 keyword）→ error 观察", async () => {
    const [qc] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qc.execute({ keyword: "   " })) as {
      error: string
    }
    expect(out.error).toContain("invalid arguments")
  })

  it("命中城市 → 返回城市数组，且按日/英文 ILIKE 查询", async () => {
    const { session, or } = mockSession([
      { id: "c1", name_ja: "東京", name_en: "Tokyo", timezone: "Asia/Tokyo" },
    ])
    const [qc] = buildMainAgentTools(buildCtx({ session }))
    const out = JSON.parse(await qc.execute({ keyword: "tokyo" })) as {
      cities: unknown[]
    }
    expect(out.cities).toEqual([
      { id: "c1", name_ja: "東京", name_en: "Tokyo", timezone: "Asia/Tokyo" },
    ])
    expect(or).toHaveBeenCalledWith(
      "name_ja.ilike.%tokyo%,name_en.ilike.%tokyo%"
    )
  })

  it("关键字含通配符 → 转义后查询（% 按字面匹配）", async () => {
    const { session, or } = mockSession([])
    const [qc] = buildMainAgentTools(buildCtx({ session }))
    await qc.execute({ keyword: "a%b" })
    expect(or).toHaveBeenCalledWith(
      "name_ja.ilike.%a\\%b%,name_en.ilike.%a\\%b%"
    )
  })

  it("关键字含逗号 → 转义为 \\,（不切断 .or() 条件分隔）", async () => {
    // 模型问 "Tokyo, Japan"：逗号是 PostgREST .or() 的条件分隔符，不转义会把过滤串
    // 切成多个条件导致查询失败；escapeIlike 需一并转义为字面逗号
    const { session, or } = mockSession([])
    const [qc] = buildMainAgentTools(buildCtx({ session }))
    await qc.execute({ keyword: "Tokyo, Japan" })
    expect(or).toHaveBeenCalledWith(
      "name_ja.ilike.%Tokyo\\, Japan%,name_en.ilike.%Tokyo\\, Japan%"
    )
  })

  it("无匹配 → 空数组", async () => {
    const [qc] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qc.execute({ keyword: "nonexistent" })) as {
      cities: unknown[]
    }
    expect(out.cities).toEqual([])
  })

  it("data 为 null（返回空）→ 空数组", async () => {
    const { session } = mockSession(null as unknown as unknown[])
    const [qc] = buildMainAgentTools(buildCtx({ session }))
    const out = JSON.parse(await qc.execute({ keyword: "tokyo" })) as {
      cities: unknown[]
    }
    expect(out.cities).toEqual([])
  })

  it("只查活跃城市（is_active=true）", async () => {
    const { session, eq } = mockSession([])
    const [qc] = buildMainAgentTools(buildCtx({ session }))
    await qc.execute({ keyword: "tokyo" })
    expect(eq).toHaveBeenCalledWith("is_active", true)
  })

  it("查询报错 → error 观察而非崩溃", async () => {
    const { session } = mockSession([], { message: "boom" })
    const [qc] = buildMainAgentTools(buildCtx({ session }))
    const out = JSON.parse(await qc.execute({ keyword: "tokyo" })) as {
      error: string
    }
    expect(out.error).toBe("city search failed")
  })

  it("查询抛异常（如网络中断）→ error 观察而非崩溃", async () => {
    const { session, from } = mockSession([])
    from.mockImplementation(() => {
      throw new Error("boom")
    })
    const [qc] = buildMainAgentTools(buildCtx({ session }))
    const out = JSON.parse(await qc.execute({ keyword: "tokyo" })) as {
      error: string
    }
    expect(out.error).toBe("city search failed")
  })
})

describe("query_sources", () => {
  // query_sources 在工具数组第二位：[query_city, query_sources, query_forecast, generate_forecast]
  const qs = (ctx = buildCtx()) => buildMainAgentTools(ctx)[1]

  const DAILY_ROWS = [
    {
      source: "open-meteo",
      day: "2026-08-11",
      high_temp: 32,
      low_temp: 24,
      precipitation: 0,
      condition_label: "Sunny",
      condition_category: "clear",
    },
    {
      source: "openweather",
      day: "2026-08-11",
      high_temp: 33,
      low_temp: 25,
      precipitation: 0.5,
      condition_label: "Partly cloudy",
      condition_category: "partlyCloudy",
    },
  ]

  it("非法 cityId → error 观察，不触查询", async () => {
    const out = JSON.parse(await qs().execute({ cityId: "not-a-uuid" })) as {
      error: string
    }
    expect(out.error).toContain("invalid arguments")
  })

  it("城市不存在 → no-data，不查 weather_daily", async () => {
    const { session, from } = mockSourceSession({ city: null, daily: [] })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      status: string
    }
    expect(out.status).toBe("no-data")
    expect(from.mock.calls.every(([t]) => t !== "weather_daily")).toBe(true)
  })

  it("城市查询报错（DB 故障）→ error 观察而非 no-data", async () => {
    const { session } = mockSourceSession({
      city: null,
      cityError: { message: "boom" },
      daily: [],
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      error: string
    }
    expect(out.error).toBe("source data query failed")
  })

  it("城市存在但无当日快照 → no-data", async () => {
    const { session } = mockSourceSession({
      city: { timezone: "Asia/Tokyo" },
      daily: [],
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      status: string
    }
    expect(out.status).toBe("no-data")
  })

  it("成功 → 按源映射（label 显示名 + 各源快照），day 为城市本地日期", async () => {
    const { session } = mockSourceSession({
      city: { timezone: "Asia/Tokyo" },
      daily: DAILY_ROWS,
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      status: string
      cityId: string
      day: string
      sources: {
        source: string
        label: string
        high: number
        low: number
        precipitationMm: number
        conditionLabel: string | null
        conditionCategory: string | null
      }[]
    }
    expect(out.status).toBe("success")
    expect(out.cityId).toBe(CITY_ID)
    expect(out.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(out.sources).toEqual([
      {
        source: "open-meteo",
        label: "Open-Meteo",
        high: 32,
        low: 24,
        precipitationMm: 0,
        conditionLabel: "Sunny",
        conditionCategory: "clear",
      },
      {
        source: "openweather",
        label: "OpenWeatherMap",
        high: 33,
        low: 25,
        precipitationMm: 0.5,
        conditionLabel: "Partly cloudy",
        conditionCategory: "partlyCloudy",
      },
    ])
  })

  it("unknown 源名 → label 回退源 key（防编造）", async () => {
    const { session } = mockSourceSession({
      city: { timezone: "Asia/Tokyo" },
      daily: [
        {
          source: "weatherapi",
          day: "2026-08-11",
          high_temp: 30,
          low_temp: 22,
          precipitation: 1,
          condition_label: "Rain",
          condition_category: "rain",
        },
      ],
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      sources: { source: string; label: string }[]
    }
    expect(out.sources[0]).toMatchObject({ source: "weatherapi", label: "WeatherAPI" })
  })

  it("未知源 + 缺失条件字段 → label 回退源 key、condition 为 null", async () => {
    const { session } = mockSourceSession({
      city: { timezone: "Asia/Tokyo" },
      daily: [
        {
          source: "unknown-src",
          day: "2026-08-11",
          high_temp: 30,
          low_temp: 20,
          precipitation: 0,
          condition_label: null,
          condition_category: null,
        },
      ],
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      status: string
      sources: {
        source: string
        label: string
        high: number
        low: number
        precipitationMm: number
        conditionLabel: string | null
        conditionCategory: string | null
      }[]
    }
    expect(out.status).toBe("success")
    expect(out.sources[0]).toEqual({
      source: "unknown-src",
      label: "unknown-src",
      high: 30,
      low: 20,
      precipitationMm: 0,
      conditionLabel: null,
      conditionCategory: null,
    })
  })

  it("快照查询返回 null（data 为空）→ 同样 no-data", async () => {
    const { session } = mockSourceSession({
      city: { timezone: "Asia/Tokyo" },
      daily: null as unknown as unknown[],
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      status: string
    }
    expect(out.status).toBe("no-data")
  })

  it("daily 查询报错 → error 观察而非崩溃", async () => {
    const { session } = mockSourceSession({
      city: { timezone: "Asia/Tokyo" },
      daily: [],
      dailyError: { message: "boom" },
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      error: string
    }
    expect(out.error).toBe("source data query failed")
  })

  it("执行抛异常 → error 观察而非崩溃", async () => {
    const { session, from } = mockSourceSession({
      city: { timezone: "Asia/Tokyo" },
      daily: DAILY_ROWS,
    })
    from.mockImplementation(() => {
      throw new Error("boom")
    })
    const out = JSON.parse(await qs(buildCtx({ session })).execute({ cityId: CITY_ID })) as {
      error: string
    }
    expect(out.error).toBe("source data query failed")
  })
})

describe("query_weather_history", () => {
  // query_weather_history 在工具数组第三位：[query_city, query_sources, query_weather_history, query_forecast, generate_forecast]
  const qh = (ctx = buildCtx()) => buildMainAgentTools(ctx)[2]

  // 按 Supabase order(day asc) 的真实返回序排列：先 08-10、后 08-11（双源）
  const HISTORY_ROWS = [
    {
      source: "open-meteo",
      day: "2026-08-10",
      high_temp: 31,
      low_temp: 23,
      precipitation: 12,
      condition_label: "Rain",
      condition_category: "rain",
    },
    {
      source: "open-meteo",
      day: "2026-08-11",
      high_temp: 32,
      low_temp: 24,
      precipitation: 0,
      condition_label: "Sunny",
      condition_category: "clear",
    },
    {
      source: "openweather",
      day: "2026-08-11",
      high_temp: 33,
      low_temp: 25,
      precipitation: 0.5,
      condition_label: "Partly cloudy",
      condition_category: "partlyCloudy",
    },
  ]

  it("非法参数（cityId 非 uuid）→ error 观察，不触查询", async () => {
    const out = JSON.parse(await qh().execute({ cityId: "not-a-uuid" })) as {
      error: string
    }
    expect(out.error).toContain("invalid arguments")
  })

  it("days 越界（0 或 8）→ error 观察", async () => {
    const high = JSON.parse(await qh().execute({ cityId: CITY_ID, days: 8 })) as {
      error: string
    }
    expect(high.error).toContain("invalid arguments")
    const low = JSON.parse(await qh().execute({ cityId: CITY_ID, days: 0 })) as {
      error: string
    }
    expect(low.error).toContain("invalid arguments")
  })

  it("城市不存在 → no-data，不查 weather_daily", async () => {
    const { session, from } = mockHistorySession({ city: null })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      status: string
    }
    expect(out.status).toBe("no-data")
    expect(from.mock.calls.every(([t]) => t !== "weather_daily")).toBe(true)
  })

  it("城市查询报错（DB 故障）→ error 观察而非 no-data", async () => {
    const { session } = mockHistorySession({
      city: null,
      cityError: { message: "boom" },
    })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      error: string
    }
    expect(out.error).toBe("history data query failed")
  })

  it("窗口内无快照 → no-data", async () => {
    const { session } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rows: [],
    })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      status: string
    }
    expect(out.status).toBe("no-data")
  })

  it("查询返回 null（data 为空）→ 同样 no-data", async () => {
    const { session } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rows: null as unknown as unknown[],
    })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      status: string
    }
    expect(out.status).toBe("no-data")
  })

  it("历史逐源映射：未知源 label 回退源 key、缺失条件字段为 null", async () => {
    const { session } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rows: [
        {
          source: "unknown-src",
          day: "2026-08-11",
          high_temp: 30,
          low_temp: 20,
          precipitation: 0,
          condition_label: null,
          condition_category: null,
        },
      ],
    })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      status: string
      days: { day: string; sources: Record<string, unknown>[] }[]
    }
    expect(out.status).toBe("success")
    expect(out.days[0].sources[0]).toEqual({
      source: "unknown-src",
      label: "unknown-src",
      high: 30,
      low: 20,
      precipitationMm: 0,
      conditionLabel: null,
      conditionCategory: null,
    })
  })

  it("默认 days=7 → 按近 7 天窗口查询（gte=6 天前、lte=今日）", async () => {
    const { session, gte, lte } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rows: HISTORY_ROWS,
    })
    await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    expect(gte).toHaveBeenCalledWith("day", daysAgoLocalDateKey("Asia/Tokyo", 6))
    expect(lte).toHaveBeenCalledWith(
      "day",
      toLocalDateKey(new Date().toISOString(), "Asia/Tokyo")
    )
  })

  it("days=3 → 按近 3 天窗口查询", async () => {
    const { session, gte } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rows: HISTORY_ROWS,
    })
    await qh(buildCtx({ session })).execute({ cityId: CITY_ID, days: 3 })
    expect(gte).toHaveBeenCalledWith("day", daysAgoLocalDateKey("Asia/Tokyo", 2))
  })

  it("成功 → 按城市本地日分组（天内逐源），附窗口 from/to", async () => {
    const { session } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rows: HISTORY_ROWS,
    })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      status: string
      cityId: string
      from: string
      to: string
      days: { day: string; sources: Record<string, unknown>[] }[]
    }
    expect(out.status).toBe("success")
    expect(out.cityId).toBe(CITY_ID)
    expect(out.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(out.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(out.days).toHaveLength(2)
    expect(out.days[0].day).toBe("2026-08-10")
    expect(out.days[0].sources).toEqual([
      {
        source: "open-meteo",
        label: "Open-Meteo",
        high: 31,
        low: 23,
        precipitationMm: 12,
        conditionLabel: "Rain",
        conditionCategory: "rain",
      },
    ])
    expect(out.days[1].day).toBe("2026-08-11")
    expect(out.days[1].sources).toEqual([
      {
        source: "open-meteo",
        label: "Open-Meteo",
        high: 32,
        low: 24,
        precipitationMm: 0,
        conditionLabel: "Sunny",
        conditionCategory: "clear",
      },
      {
        source: "openweather",
        label: "OpenWeatherMap",
        high: 33,
        low: 25,
        precipitationMm: 0.5,
        conditionLabel: "Partly cloudy",
        conditionCategory: "partlyCloudy",
      },
    ])
  })

  it("daily 查询报错 → error 观察而非崩溃", async () => {
    const { session } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rowsError: { message: "boom" },
    })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      error: string
    }
    expect(out.error).toBe("history data query failed")
  })

  it("执行抛异常 → error 观察而非崩溃", async () => {
    const { session, from } = mockHistorySession({
      city: { timezone: "Asia/Tokyo" },
      rows: HISTORY_ROWS,
    })
    from.mockImplementation(() => {
      throw new Error("boom")
    })
    const out = JSON.parse(
      await qh(buildCtx({ session })).execute({ cityId: CITY_ID })
    ) as {
      error: string
    }
    expect(out.error).toBe("history data query failed")
  })
})

describe("query_forecast", () => {
  it("非法 cityId → error 观察", async () => {
    const [, , , qf] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qf.execute({ cityId: "not-a-uuid" })) as {
      error: string
    }
    expect(out.error).toContain("invalid arguments")
  })

  it("无数据（read 返回 null）→ no-data", async () => {
    vi.mocked(readForecastForCity).mockResolvedValue(null)
    const [, , , qf] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qf.execute({ cityId: CITY_ID })) as {
      status: string
    }
    expect(out.status).toBe("no-data")
  })

  it("success 行 → 指标观察（含结构化指标，不内联 markdown）", async () => {
    vi.mocked(readForecastForCity).mockResolvedValue(SUCCESS_ROW)
    const [, , , qf] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qf.execute({ cityId: CITY_ID })) as {
      status: string
      day: string
      metrics: { predicted_high: number }
      markdown_body?: string
    }
    expect(out.status).toBe("success")
    expect(out.day).toBe("2026-08-11")
    expect(out.metrics.predicted_high).toBe(33.5)
    expect(out.markdown_body).toBeUndefined()
  })

  it("failed 行 → error + 透传 error_code", async () => {
    vi.mocked(readForecastForCity).mockResolvedValue({
      ...SUCCESS_ROW,
      status: "failed",
      error_code: "provider",
    })
    const [, , , qf] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qf.execute({ cityId: CITY_ID })) as {
      status: string
      code: string
    }
    expect(out.status).toBe("error")
    expect(out.code).toBe("provider")
  })

  it("failed 行且 error_code 为空 → code 兜底 generic", async () => {
    vi.mocked(readForecastForCity).mockResolvedValue({
      ...SUCCESS_ROW,
      status: "failed",
      error_code: null,
    })
    const [, , , qf] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qf.execute({ cityId: CITY_ID })) as {
      status: string
      code: string
    }
    expect(out).toEqual({ status: "error", code: "generic" })
  })

  it("pending 行（另一请求生成中）→ pending + generating", async () => {
    vi.mocked(readForecastForCity).mockResolvedValue({
      ...SUCCESS_ROW,
      status: "pending",
    })
    const [, , , qf] = buildMainAgentTools(buildCtx())
    const out = JSON.parse(await qf.execute({ cityId: CITY_ID })) as {
      status: string
      code: string
    }
    expect(out).toEqual({ status: "pending", code: "generating" })
  })
})

describe("generate_forecast", () => {
  const gf = () => buildMainAgentTools(buildCtx())[4]

  it("无 email → unauthorized，不触子 Agent", async () => {
    const tool = buildMainAgentTools(buildCtx({ email: null }))[4]
    const out = JSON.parse(await tool.execute({ cityId: CITY_ID })) as {
      status: string
      code: string
    }
    expect(out).toEqual({ status: "error", code: "unauthorized" })
    expect(runForecastAgentStream).not.toHaveBeenCalled()
  })

  it("非法 cityId → error 观察，不触子 Agent", async () => {
    const out = JSON.parse(await gf().execute({ cityId: "bad" })) as {
      error: string
    }
    expect(out.error).toContain("invalid arguments")
    expect(runForecastAgentStream).not.toHaveBeenCalled()
  })

  it("done 事件 → success 指标观察", async () => {
    vi.mocked(runForecastAgentStream).mockReturnValue(
      genFrom([{ type: "done" as const, row: SUCCESS_ROW }])
    )
    const out = JSON.parse(await gf().execute({ cityId: CITY_ID })) as {
      status: string
      metrics: { predicted_high: number }
    }
    expect(out.status).toBe("success")
    expect(out.metrics.predicted_high).toBe(33.5)
    // 委托负载：把 cityId/email/locale/model 原样下发给子 Agent（认领写归属 + 生成定稿语言）
    expect(runForecastAgentStream).toHaveBeenCalledWith(
      expect.any(Object), // session 读客户端
      expect.any(Object), // service 写客户端
      {
        cityId: CITY_ID,
        email: "a@b.com",
        locale: "zh",
        model: { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
      }
    )
  })

  it("duplicate 事件（已有行）→ 同样返回 success 观察", async () => {
    vi.mocked(runForecastAgentStream).mockReturnValue(
      genFrom([{ type: "duplicate" as const, row: SUCCESS_ROW }])
    )
    const out = JSON.parse(await gf().execute({ cityId: CITY_ID })) as {
      status: string
    }
    expect(out.status).toBe("success")
  })

  it("error 事件 → 透传子 Agent 错误码", async () => {
    vi.mocked(runForecastAgentStream).mockReturnValue(
      genFrom([{ type: "error" as const, code: "insufficient-data" }])
    )
    const out = JSON.parse(await gf().execute({ cityId: CITY_ID })) as {
      status: string
      code: string
    }
    expect(out).toEqual({ status: "error", code: "insufficient-data" })
  })

  it("流结束无终态（仅中间 status）→ generic", async () => {
    vi.mocked(runForecastAgentStream).mockReturnValue(
      genFrom([{ type: "status" as const, phase: "start" }])
    )
    const out = JSON.parse(await gf().execute({ cityId: CITY_ID })) as {
      status: string
      code: string
    }
    expect(out).toEqual({ status: "error", code: "generic" })
  })

  it("子 Agent 抛异常 → generic", async () => {
    vi.mocked(runForecastAgentStream).mockImplementation(() => {
      throw new Error("boom")
    })
    const out = JSON.parse(await gf().execute({ cityId: CITY_ID })) as {
      status: string
      code: string
    }
    expect(out).toEqual({ status: "error", code: "generic" })
  })
})

// 工具定义契约：模型看到的 name/description/parameters 即函数调用 schema，
// 锁定它避免误改破坏工具调用；description 文案随 locale 切换
describe("工具定义契约", () => {
  it("zh：五个工具的名字/描述/参数 schema 与模型看到的契约一致", () => {
    const [qc, qs, qh, qf, gf] = buildMainAgentTools(buildCtx({ locale: "zh" }))
    expect(qc).toEqual({
      name: "query_city",
      description:
        "按城市名（日文或英文）搜索平台支持的城市，返回城市 id、中/英文名与时区；无匹配返回空数组。",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", minLength: 1 } },
        required: ["keyword"],
        additionalProperties: false,
      },
      execute: expect.any(Function),
    })
    expect(qs).toEqual({
      name: "query_sources",
      description:
        "查询某城市今日在 3 个数据源（open-meteo/openweather/weatherapi）各自的预报快照（高温/低温/降水/天气状况），用于逐源对比；尚未采集时返回 no-data。cityId 需来自 query_city。",
      parameters: {
        type: "object",
        properties: { cityId: { type: "string", format: "uuid" } },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: expect.any(Function),
    })
    expect(qh).toEqual({
      name: "query_weather_history",
      description:
        "查询某城市近几日（最多 7 天，含今日）各数据源的历史每日快照（高温/低温/降水/天气状况），按城市本地日分组返回；平台仅保留近 7 天数据。cityId 需来自 query_city；days 为回看天数，不传默认 7。",
      parameters: {
        type: "object",
        properties: {
          cityId: { type: "string", format: "uuid" },
          days: { type: "integer", minimum: 1, maximum: 7 },
        },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: expect.any(Function),
    })
    expect(qf).toEqual({
      name: "query_forecast",
      description:
        "查询某城市今日的预报数据（温度/降水/风等权威指标）；尚未生成时返回 no-data。cityId 需来自 query_city。",
      parameters: {
        type: "object",
        properties: { cityId: { type: "string", format: "uuid" } },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: expect.any(Function),
    })
    expect(gf).toEqual({
      name: "generate_forecast",
      description:
        "委托 ForecastAgent 子 Agent 生成（或获取已有的）某城市今日预报，返回权威指标。仅在 query_forecast 返回 no-data 时调用，耗时较长。cityId 需来自 query_city。",
      parameters: {
        type: "object",
        properties: { cityId: { type: "string", format: "uuid" } },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: expect.any(Function),
    })
  })

  it("en：描述跟随英文，防止英文模式被中文文案带偏", () => {
    const [qc, qs, qh, qf, gf] = buildMainAgentTools(buildCtx({ locale: "en" }))
    expect(qc.description).toBe(
      "Search supported cities by name (Japanese or English); returns city id, names, and timezone. Empty array when no match."
    )
    expect(qs.description).toBe(
      "Read a city's per-source forecast snapshot for today from the 3 data sources (open-meteo/openweather/weatherapi): high/low, precipitation, condition — for cross-source comparison; returns no-data when not collected. cityId must come from query_city."
    )
    expect(qh.description).toBe(
      "Read a city's recent per-source daily snapshots (up to 7 days including today): high/low, precipitation, condition — grouped by local day; the platform keeps only the last 7 days. cityId must come from query_city; days is the lookback count, defaults to 7."
    )
    expect(qf.description).toBe(
      "Read a city's forecast for today (authoritative metrics); returns no-data when not generated. cityId must come from query_city."
    )
    expect(gf.description).toBe(
      "Delegate to the ForecastAgent sub-agent to generate (or fetch the existing) today's forecast for a city, returning authoritative metrics. Use only when query_forecast returns no-data; may take a while. cityId must come from query_city."
    )
  })
})
