import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  CityPoint,
  NormalizedWeather,
  WeatherSource,
} from "@/lib/schemas/weather"
import { createServiceClient } from "@/supabase/service"
import {
  daysAgoLocalDateKey,
  todayAggregate,
} from "@/lib/weather/daily"
import { providers, type AdapterErrorCode } from "@/lib/weather/providers"

export type RunStatus = "success" | "partial" | "failed"
export type RunTrigger = "manual" | "cron"
// 单格失败原因：adapter 层错误码 + DB 落库错误
export type CellError = AdapterErrorCode | "db"

export type RunSummary = {
  runId: string
  status: RunStatus
  trigger: RunTrigger
  totalCells: number
  succeeded: number
  failed: number
  errors: { city: string; source: WeatherSource; error: CellError }[]
}

// cities 表行（snake_case）类型来源；无生成 Database 类型，边界处本地断言
type CityRow = {
  id: string
  name_ja: string
  name_en: string
  latitude: number
  longitude: number
  timezone: string
}

function toCityPoint(row: CityRow): CityPoint {
  return {
    id: row.id,
    nameJa: row.name_ja,
    nameEn: row.name_en,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
  }
}

// 单格落库：实时 upsert + 每日快照 upsert；任一失败抛错，由外层降级为该格 db 失败
async function writeCell(
  supabase: SupabaseClient,
  city: CityPoint,
  data: NormalizedWeather
): Promise<void> {
  const now = new Date().toISOString()

  const { error: currentError } = await supabase.from("weather_current").upsert(
    {
      city_id: city.id,
      source: data.source,
      observed_at: data.current.observedAt,
      temperature: data.current.temperature,
      feels_like: data.current.feelsLike ?? null,
      humidity: data.current.humidity ?? null,
      pressure: data.current.pressure ?? null,
      wind_speed: data.current.windSpeed,
      wind_direction: data.current.windDirection ?? null,
      precipitation: data.current.precipitation,
      condition_code: data.current.conditionCode,
      condition_label: data.current.conditionLabel,
      condition_category: data.current.conditionCategory,
      raw: data.raw,
      updated_at: now,
    },
    { onConflict: "city_id,source" }
  )
  if (currentError) throw new Error(currentError.message)

  // 每日快照落库（覆盖当日一行），失败由外层 catch 计为该格 db 失败
  await writeDailyRow(supabase, city, data)
}

// 单格每日快照：按城市本地日聚合预报 slot，upsert 覆盖当日一行（onConflict 城×源×日）；
// 预报不含当天 slot（OWM 午夜边界）时由 todayAggregate 用实时数据兜底，保证当天必有一行。
// temperature 取采集时刻实时温度作为当日快照
async function writeDailyRow(
  supabase: SupabaseClient,
  city: CityPoint,
  data: NormalizedWeather
): Promise<void> {
  const agg = todayAggregate(
    city.timezone,
    data.fetchedAt,
    data.forecast,
    data.current
  )

  const { error } = await supabase.from("weather_daily").upsert(
    {
      city_id: city.id,
      source: data.source,
      day: agg.day,
      high_temp: agg.highTemp,
      low_temp: agg.lowTemp,
      temperature: data.current.temperature,
      precipitation: agg.precipitation,
      condition_code: agg.conditionCode,
      condition_label: agg.conditionLabel,
      condition_category: agg.conditionCategory,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "city_id,source,day" }
  )
  if (error) throw new Error(error.message)
}

// 运行收尾维护：清理 7 天前的每日快照维持窗口，保持表有界。
// 尽力而为：失败由调用方 catch 记录，不影响运行终态与 weather_runs
async function cleanupAfterRun(
  supabase: SupabaseClient,
  cities: CityPoint[]
): Promise<void> {
  for (const city of cities) {
    const cutoff = daysAgoLocalDateKey(city.timezone, 6)
    const { error } = await supabase
      .from("weather_daily")
      .delete()
      .eq("city_id", city.id)
      .lt("day", cutoff)
    if (error) throw new Error(error.message)
  }
}

// 主入口：对每个启用城市 × 每个数据源拉取并落库，返回运行摘要；永不抛错
export async function runWeatherPipeline(
  trigger: RunTrigger
): Promise<RunSummary> {
  // 用 service_role 客户端：开启 RLS 后 cron 无会话、anon key 读写会被拒，
  // 采集写入必须绕过 RLS（调用方已做管理员/密钥鉴权）
  const supabase = createServiceClient()

  // 1. 读启用的城市；查询失败或无城市时也记一条 failed 运行
  const { data: cityRows, error: cityError } = await supabase
    .from("cities")
    .select("*")
    .eq("is_active", true)
    .order("name_en")

  if (cityError || !cityRows || cityRows.length === 0) {
    const runId = await openRun(supabase, trigger)
    const firstError = cityError?.message ?? "no active cities"
    await finalizeRun(supabase, runId, "failed", {
      total: 0,
      succeeded: 0,
      failed: 0,
      firstError,
    })
    return {
      runId,
      status: "failed",
      trigger,
      totalCells: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
    }
  }

  const cities = (cityRows as CityRow[]).map(toCityPoint)
  const total = cities.length * providers.length
  const runId = await openRun(supabase, trigger)
  const errors: RunSummary["errors"] = []
  let succeeded = 0

  // 2. 并发拉取 城×源；adapter 自身不抛错，这里再 try/catch 兜底，
  //    单源失败只计一格，不影响整轮（闭包恒返回结果对象，绝不 reject）
  const cells = cities.flatMap((city) =>
    providers.map(async (provider) => {
      try {
        const result = await provider.fetchCurrentAndForecast(city)
        if (!result.ok) {
          return {
            city,
            source: provider.source,
            error: result.error as CellError,
          }
        }
        try {
          await writeCell(supabase, city, result.data)
          return { city, source: provider.source, ok: true }
        } catch {
          return { city, source: provider.source, error: "db" as CellError }
        }
      } catch {
        return { city, source: provider.source, error: "parse" as CellError }
      }
    })
  )

  // 单元格闭包对成功/失败都返回对象、绝不 reject，故用 all 直接收结果
  const results = await Promise.all(cells)
  for (const cell of results) {
    if ("ok" in cell) {
      succeeded += 1
    } else {
      errors.push({
        city: cell.city.nameEn,
        source: cell.source,
        error: cell.error,
      })
    }
  }
  const failed = total - succeeded

  // 3. 收尾：先做维护清理（失败仅记录，次日运行自愈），再写运行终态
  await cleanupAfterRun(supabase, cities).catch((e: unknown) => {
    console.error("清理历史天气数据失败，将于下一次运行重试", e)
  })

  const status: RunStatus =
    failed === 0 ? "success" : succeeded === 0 ? "failed" : "partial"
  const firstError = errors[0]
    ? `${errors[0].city}/${errors[0].source}:${errors[0].error}`
    : null
  await finalizeRun(supabase, runId, status, {
    total,
    succeeded,
    failed,
    firstError,
  })

  return {
    runId,
    status,
    trigger,
    totalCells: total,
    succeeded,
    failed,
    errors,
  }
}

// 登记一次运行（running 状态），返回 runId
async function openRun(
  supabase: SupabaseClient,
  trigger: RunTrigger
): Promise<string> {
  const { data } = await supabase
    .from("weather_runs")
    .insert({ status: "running", trigger })
    .select("id")
    .single()
  return data?.id ?? ""
}

// 更新运行终态与计数
async function finalizeRun(
  supabase: SupabaseClient,
  runId: string,
  status: RunStatus,
  counts: {
    total: number
    succeeded: number
    failed: number
    firstError: string | null
  }
): Promise<void> {
  if (!runId) return
  await supabase
    .from("weather_runs")
    .update({
      status,
      total_cells: counts.total,
      succeeded_cells: counts.succeeded,
      failed_cells: counts.failed,
      error: counts.firstError,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId)
}
