import type { SupabaseClient } from "@supabase/supabase-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  CityPoint,
  NormalizedWeather,
  WeatherSource,
} from "@/lib/schemas/weather"

import { runWeatherBackfill, runWeatherPipeline } from "./pipeline"

// —— 依赖 mock：service_role 客户端 + providers 注册表（pipeline 只依赖这两处）——
const serviceMock = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
const providersMock = vi.hoisted(() => ({
  current: [vi.fn(), vi.fn()],
  history: [vi.fn(), vi.fn()],
}))

vi.mock("@/supabase/service", () => ({
  createServiceClient: serviceMock.createServiceClient,
}))

vi.mock("@/lib/weather/providers", () => ({
  providers: [
    {
      source: "open-meteo",
      fetchCurrentAndForecast: providersMock.current[0],
      fetchDailyHistory: providersMock.history[0],
    },
    {
      source: "openweather",
      fetchCurrentAndForecast: providersMock.current[1],
      fetchDailyHistory: providersMock.history[1],
    },
  ],
}))

const city: CityPoint = {
  id: "c1",
  nameJa: "東京",
  nameEn: "Tokyo",
  latitude: 35.6762,
  longitude: 139.6503,
  timezone: "Asia/Tokyo",
}

// cities 表行（snake_case），对应 pipeline 内 CityRow 形状
const cityRow = {
  id: city.id,
  name_ja: city.nameJa,
  name_en: city.nameEn,
  latitude: city.latitude,
  longitude: city.longitude,
  timezone: city.timezone,
}

// 构造合法归一化天气数据（forecast 留空即可，todayAggregate 会走实时兜底）
function makeWeather(source: WeatherSource): NormalizedWeather {
  return {
    city,
    source,
    current: {
      temperature: 25,
      feelsLike: 26,
      humidity: 60,
      pressure: 1013,
      windSpeed: 3,
      windDirection: 180,
      precipitation: 0,
      conditionCode: 800,
      conditionLabel: "Clear",
      conditionCategory: "clear",
      observedAt: "2026-08-07T04:00:00.000Z",
    },
    forecast: [],
    fetchedAt: "2026-08-07T04:00:00.000Z",
    raw: {},
  }
}

// 构造链式查询 mock：select/eq/order 等返回自身（thenable），await 时按表返回预设结果。
// 关键点：update/upsert 记录写入，delete 链区分出清理分支返回独立错误
type DbResult = { data?: unknown; error?: { message: string } | null }

interface QueryBuilder {
  select: () => QueryBuilder
  eq: () => QueryBuilder
  order: () => QueryBuilder
  single: () => QueryBuilder
  insert: (rows: unknown) => QueryBuilder
  update: (rows: unknown) => QueryBuilder
  delete: () => QueryBuilder
  lt: () => QueryBuilder
  upsert: (rows: unknown, onConflict?: unknown) => QueryBuilder
  then: (onfulfilled: (value: DbResult) => void) => void
}

function makeSupabaseMock() {
  const state = {
    cities: {
      data: null as unknown,
      error: null as { message: string } | null,
    },
    runId: "run-1" as string | null,
    upsertError: null as { message: string } | null,
    dailyUpsertError: null as { message: string } | null,
    cleanupError: null as { message: string } | null,
    upserts: [] as { table: string; rows: unknown; onConflict: unknown }[],
    inserts: [] as { table: string; rows: unknown }[],
    updates: [] as { table: string; rows: unknown }[],
  }

  const client = {
    from(table: string) {
      let isDelete = false
      const q: QueryBuilder = {
        select: () => q,
        eq: () => q,
        order: () => q,
        single: () => q,
        insert: (rows: unknown) => {
          state.inserts.push({ table, rows })
          return q
        },
        update: (rows: unknown) => {
          state.updates.push({ table, rows })
          return q
        },
        delete: () => {
          isDelete = true
          return q
        },
        lt: () => q,
        upsert: (rows: unknown, onConflict: unknown) => {
          state.upserts.push({ table, rows, onConflict })
          return q
        },
        then(onfulfilled: (v: DbResult) => void) {
          onfulfilled(finalResult())
        },
      }

      function finalResult(): DbResult {
        if (table === "cities")
          return { data: state.cities.data, error: state.cities.error }
        if (table === "weather_runs")
          return { data: state.runId ? { id: state.runId } : null, error: null }
        if (table === "weather_daily" && isDelete)
          return { error: state.cleanupError }
        if (table === "weather_current") return { error: state.upsertError }
        if (table === "weather_daily")
          return { error: state.dailyUpsertError ?? state.upsertError }
        return { error: null }
      }

      return q
    },
  }

  return { client, state }
}

// 组装一次运行所需的假客户端，并挂到 createServiceClient
function stubService() {
  const { client, state } = makeSupabaseMock()
  serviceMock.createServiceClient.mockReturnValue(
    client as unknown as SupabaseClient
  )
  return state
}

// 全部 provider 返回成功，供成功路径复用
function stubAllCurrentOk() {
  providersMock.current[0].mockResolvedValue({
    ok: true,
    data: makeWeather("open-meteo"),
  })
  providersMock.current[1].mockResolvedValue({
    ok: true,
    data: makeWeather("openweather"),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("runWeatherPipeline", () => {
  it("成功：城×源全部落库，返回 success 摘要并写运行终态", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    stubAllCurrentOk()

    const summary = await runWeatherPipeline("manual")

    expect(summary).toEqual({
      runId: "run-1",
      status: "success",
      trigger: "manual",
      totalCells: 2,
      succeeded: 2,
      failed: 0,
      errors: [],
    })

    // 每个 provider 各收到一次调用，入参为城市点
    for (const fn of providersMock.current) {
      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith(city)
    }

    // 实时表 + 每日快照各一格：城×源×2 张表 = 4 次 upsert
    expect(
      state.upserts.filter((u) => u.table === "weather_current")
    ).toHaveLength(2)
    expect(
      state.upserts.filter((u) => u.table === "weather_daily")
    ).toHaveLength(2)

    // 实时行带城与源；每日行走当天快照兜底（forecast 为空 → 用 current 值）
    const currentRows = state.upserts.filter(
      (u) => u.table === "weather_current"
    )
    for (const { rows } of currentRows) {
      const row = rows as {
        city_id: string
        source: WeatherSource
        temperature: number
      }
      expect(row.city_id).toBe("c1")
      expect(row.temperature).toBe(25)
    }
    const dailyRows = state.upserts.filter((u) => u.table === "weather_daily")
    for (const { rows } of dailyRows) {
      const row = rows as {
        day: string
        high_temp: number
        temperature: number
      }
      expect(row.day).toBe("2026-08-07")
      expect(row.high_temp).toBe(25)
      expect(row.temperature).toBe(25)
    }

    // 运行登记 + 终态：running 插入一次、update 带 success 计数
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].rows).toMatchObject({
      status: "running",
      trigger: "manual",
    })
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].rows).toMatchObject({
      status: "success",
      total_cells: 2,
      succeeded_cells: 2,
      failed_cells: 0,
      error: null,
    })
  })

  it("城市查询失败：记一条 failed 运行，不调用任何 provider", async () => {
    const state = stubService()
    state.cities.error = { message: "db exploded" }

    const summary = await runWeatherPipeline("cron")

    expect(summary).toMatchObject({
      status: "failed",
      totalCells: 0,
      succeeded: 0,
      failed: 0,
    })
    for (const fn of providersMock.current) expect(fn).not.toHaveBeenCalled()
    expect(state.updates[0].rows).toMatchObject({
      status: "failed",
      error: "db exploded",
    })
  })

  it("无启用城市：返回 failed，firstError 记为 no active cities", async () => {
    const state = stubService()
    state.cities.data = []

    const summary = await runWeatherPipeline("manual")

    expect(summary.status).toBe("failed")
    expect(state.updates[0].rows).toMatchObject({
      status: "failed",
      error: "no active cities",
    })
  })

  it("单源失败：partial 摘要只计失败格", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    providersMock.current[0].mockResolvedValue({
      ok: true,
      data: makeWeather("open-meteo"),
    })
    providersMock.current[1].mockResolvedValue({ ok: false, error: "network" })

    const summary = await runWeatherPipeline("manual")

    expect(summary.status).toBe("partial")
    expect(summary.succeeded).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.errors).toEqual([
      { city: "Tokyo", source: "openweather", error: "network" },
    ])
    expect(state.updates[0].rows).toMatchObject({
      status: "partial",
      succeeded_cells: 1,
      failed_cells: 1,
    })
  })

  it("全部失败：failed 摘要", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    for (const fn of providersMock.current)
      fn.mockResolvedValue({ ok: false, error: "noData" })

    const summary = await runWeatherPipeline("manual")

    expect(summary.status).toBe("failed")
    expect(summary.succeeded).toBe(0)
    expect(summary.failed).toBe(2)
  })

  it("adapter 意外抛错：该格计 parse 失败，不影响整轮", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    providersMock.current[0].mockRejectedValue(new Error("boom"))
    providersMock.current[1].mockResolvedValue({
      ok: true,
      data: makeWeather("openweather"),
    })

    const summary = await runWeatherPipeline("manual")

    expect(summary.status).toBe("partial")
    expect(summary.errors).toEqual([
      { city: "Tokyo", source: "open-meteo", error: "parse" },
    ])
  })

  it("落库失败：该格计 db 失败", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    stubAllCurrentOk()
    state.upsertError = { message: "db down" }

    const summary = await runWeatherPipeline("manual")

    expect(summary.status).toBe("failed")
    expect(summary.succeeded).toBe(0)
    expect(summary.failed).toBe(2)
    expect(summary.errors.every((e) => e.error === "db")).toBe(true)
  })

  it("每日快照落库失败：该格计 db 失败（实时行已写入）", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    stubAllCurrentOk()
    state.dailyUpsertError = { message: "daily down" }

    const summary = await runWeatherPipeline("manual")

    expect(summary.status).toBe("failed")
    expect(summary.succeeded).toBe(0)
    expect(summary.errors.every((e) => e.error === "db")).toBe(true)
    // 实时行 upsert 已执行，每日表也尝试写入但因落库错误该格计 db
    expect(
      state.upserts.filter((u) => u.table === "weather_current")
    ).toHaveLength(2)
    expect(
      state.upserts.filter((u) => u.table === "weather_daily")
    ).toHaveLength(2)
  })

  it("收尾清理失败仅记录日志，不影响运行终态", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    stubAllCurrentOk()
    state.cleanupError = { message: "cleanup broken" }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const summary = await runWeatherPipeline("manual")

    expect(summary.status).toBe("success")
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("runId 为空时跳过运行终态写入", async () => {
    const state = stubService()
    state.cities.data = [cityRow]
    state.runId = null
    stubAllCurrentOk()

    const summary = await runWeatherPipeline("manual")

    expect(summary.runId).toBe("")
    expect(state.updates).toHaveLength(0)
  })
})

describe("runWeatherBackfill", () => {
  // 回填窗口：2026-08-07 起 7 天 → [2026-08-01, 2026-08-07]（Asia/Tokyo）
  const historyDaily = [
    {
      day: "2026-08-01",
      highTemp: 30,
      lowTemp: 24,
      precipitation: 0,
      conditionCode: 0,
      conditionLabel: "Clear",
      conditionCategory: "clear",
    },
    {
      day: "2026-08-07",
      highTemp: 28,
      lowTemp: 25,
      precipitation: 2,
      conditionCode: 61,
      conditionLabel: "Rain",
      conditionCategory: "rain",
    },
    // 窗口外的一天，应被 recentWindow 过滤
    {
      day: "2026-08-10",
      highTemp: 32,
      lowTemp: 26,
      precipitation: 0,
      conditionCode: 1,
      conditionLabel: "Clouds",
      conditionCategory: "partlyCloudy",
    },
  ]

  function stubAllHistoryOk() {
    for (const fn of providersMock.history)
      fn.mockResolvedValue({ ok: true, daily: historyDaily })
  }

  it("成功：按窗口过滤逐日落库，trigger 恒为 manual", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
    const state = stubService()
    state.cities.data = [cityRow]
    stubAllHistoryOk()

    const summary = await runWeatherBackfill(7)

    expect(summary.status).toBe("success")
    expect(summary.trigger).toBe("manual")
    expect(summary.totalCells).toBe(2)

    // 只写 weather_daily，不写实时表；窗口外的一天被过滤
    expect(
      state.upserts.filter((u) => u.table === "weather_current")
    ).toHaveLength(0)
    const dailyRows = state.upserts.filter((u) => u.table === "weather_daily")
    expect(dailyRows).toHaveLength(4) // 2 provider × 2 窗口内天
    const days = new Set(
      dailyRows.map(({ rows }) => (rows as { day: string }).day)
    )
    expect([...days].sort()).toEqual(["2026-08-01", "2026-08-07"])

    // temperature 取高低温均值占位；每日行 onConflict 城×源×日
    const row = dailyRows[0].rows as { temperature: number; high_temp: number }
    expect(row.temperature).toBe(
      (row.high_temp + (dailyRows[0].rows as { low_temp: number }).low_temp) / 2
    )

    // 运行登记为 running/manual，终态 success
    expect(state.inserts[0].rows).toMatchObject({
      status: "running",
      trigger: "manual",
    })
    expect(state.updates[0].rows).toMatchObject({ status: "success" })
  })

  it("回填落库失败：该格计 db 失败", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
    const state = stubService()
    state.cities.data = [cityRow]
    stubAllHistoryOk()
    state.upsertError = { message: "db down" }

    const summary = await runWeatherBackfill(7)

    expect(summary.status).toBe("failed")
    expect(summary.errors.every((e) => e.error === "db")).toBe(true)
  })

  it("无启用城市：返回 failed", async () => {
    const state = stubService()
    state.cities.data = []

    const summary = await runWeatherBackfill(7)

    expect(summary.status).toBe("failed")
    expect(summary.totalCells).toBe(0)
    expect(state.updates[0].rows).toMatchObject({
      status: "failed",
      error: "no active cities",
    })
  })

  it("历史接口返回错误：该格计对应错误码", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
    const state = stubService()
    state.cities.data = [cityRow]
    providersMock.history[0].mockResolvedValue({ ok: false, error: "http" })
    providersMock.history[1].mockResolvedValue({
      ok: true,
      daily: historyDaily,
    })

    const summary = await runWeatherBackfill(7)

    expect(summary.status).toBe("partial")
    expect(summary.errors).toEqual([
      { city: "Tokyo", source: "open-meteo", error: "http" },
    ])
  })

  it("历史接口意外抛错：该格计 parse 失败", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-07T04:00:00Z"))
    const state = stubService()
    state.cities.data = [cityRow]
    providersMock.history[0].mockRejectedValue(new Error("boom"))
    providersMock.history[1].mockResolvedValue({
      ok: true,
      daily: historyDaily,
    })

    const summary = await runWeatherBackfill(7)

    expect(summary.status).toBe("partial")
    expect(summary.errors).toEqual([
      { city: "Tokyo", source: "open-meteo", error: "parse" },
    ])
  })
})
