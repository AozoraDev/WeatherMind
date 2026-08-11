import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  ForecastDbRow,
  SourceInput,
} from "@/lib/schemas/forecast-agent"
import {
  conditionCategorySchema,
  type ConditionCategory,
} from "@/lib/schemas/weather"
import { toLocalDateKey } from "@/lib/weather/daily"

// ForecastAgent 的持久化原语：预测行（forecast_agent_predictions）的读/认领/写入，
// 以及「当日源输入」的组装。编排逻辑（stream.ts）只调这里的原语，不直接碰表

// 失败冷却时长：生成失败后 5 分钟内禁止重试同一 城×日×语言，防失败重试无限刷服务器
// （替代原「每日 10 次」配额：正常使用不限次数，只挡失败重试循环）
export const RETRY_COOLDOWN_MS = 5 * 60 * 1000

// 冷却判定：failed 行距失败时刻是否仍在冷却期内。failed_at 缺失（旧数据/成功行）按未冷却处理
export function isWithinRetryCooldown(
  failedAt: string | null,
  now: number
): boolean {
  if (!failedAt) return false
  return now - new Date(failedAt).getTime() < RETRY_COOLDOWN_MS
}

// 页面只读：按 城×日×语言 取既有预测行（可能 pending/success/failed），无则 null。
// AI 文案语言在生成时定稿、读时不转译，故按 locale 分开读，切换语言读到对应语言那条
export async function readForecast(
  supabase: SupabaseClient,
  cityId: string,
  day: string,
  locale: string
): Promise<ForecastDbRow | null> {
  const { data } = await supabase
    .from("forecast_agent_predictions")
    .select("*")
    .eq("city_id", cityId)
    .eq("day", day)
    .eq("locale", locale)
    .maybeSingle()
  return (data ?? null) as ForecastDbRow | null
}

// 只读入口：按 城×语言 取当前行；本地日按城市时区实时计算。
// 供生成进度轮询共用（day 服务端算，防客户端时区漂移）；city 查询失败返回 null，由调用方兜底
export async function readForecastForCity(
  supabase: SupabaseClient,
  cityId: string,
  locale: string
): Promise<ForecastDbRow | null> {
  const cityRes = await supabase
    .from("cities")
    .select("*")
    .eq("id", cityId)
    .eq("is_active", true)
    .maybeSingle()
  const city = cityRes.data as { timezone: string } | null
  if (!city) return null
  const day = toLocalDateKey(new Date().toISOString(), city.timezone)
  return readForecast(supabase, cityId, day, locale)
}

// 认领 pending 行：insert 命中唯一键 23505 说明已被认领，读回现有行。
// 读回的是 failed 时视为重试：转回 pending（清 error_code / failed_at，重新计时）继续本次生成。
// 唯一键为 城×日×语言，不同语言各认领各的，互不干扰；冷却期判定在 stream 读路径前置拦截
export async function claimPending(
  service: SupabaseClient,
  cityId: string,
  day: string,
  locale: string,
  email: string
): Promise<{ row: ForecastDbRow; claimed: boolean } | null> {
  const { data, error } = await service
    .from("forecast_agent_predictions")
    .insert({
      city_id: cityId,
      day,
      locale,
      status: "pending",
      created_by: email,
    })
    .select()
    .maybeSingle()
  if (!error && data) return { row: data as ForecastDbRow, claimed: true }
  if (error?.code !== "23505") return null
  const { data: existing } = await service
    .from("forecast_agent_predictions")
    .select("*")
    .eq("city_id", cityId)
    .eq("day", day)
    .eq("locale", locale)
    .maybeSingle()
  if (!existing) return null
  // success/pending → 只读返回；failed → 重试认领（更新回 pending 后继续生成，清冷却计时）
  if ((existing as ForecastDbRow).status === "failed") {
    const { data: updated } = await service
      .from("forecast_agent_predictions")
      .update({
        status: "pending",
        created_by: email,
        error_code: null,
        failed_at: null,
      })
      .eq("id", (existing as ForecastDbRow).id)
      .select()
      .maybeSingle()
    if (updated) return { row: updated as ForecastDbRow, claimed: true }
    return null
  }
  return { row: existing as ForecastDbRow, claimed: false }
}

// settle：写终态；success 带全部指标与 AI 文案，failed 仅作 delete 失败兜底
export async function settleRow(
  service: SupabaseClient,
  rowId: string,
  patch: Partial<ForecastDbRow>
): Promise<boolean> {
  const { error } = await service
    .from("forecast_agent_predictions")
    .update(patch)
    .eq("id", rowId)
  return !error
}

// 每日清理：整表清空 predictions（次日各城按需重新生成）。
// 行按 城×日×语言 唯一，跨日数据对当天展示无意义，只增不清会随每天点击无限膨胀；
// supabase delete 必须带过滤条件，用不可能存在的 uuid 作恒假条件实现「删全表」。
// 供每日定时任务调用（scripts/weather-cron.ts），尽力而为、失败由调用方记日志
export async function clearPredictions(
  service: SupabaseClient
): Promise<boolean> {
  const { error } = await service
    .from("forecast_agent_predictions")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000")
  return !error
}

// 当日源输入：weather_daily 的 城×日 行（高/低/降水/条件）为核心；
// 湿度/风当日每日表没有，取 weather_current 当日快照作为代理（缺则 null，集成会跳过）
export async function buildSourceInputs(
  supabase: SupabaseClient,
  cityId: string,
  day: string
): Promise<SourceInput[]> {
  const [dailyRes, currentRes] = await Promise.all([
    supabase
      .from("weather_daily")
      .select("*")
      .eq("city_id", cityId)
      .eq("day", day),
    supabase.from("weather_current").select("*").eq("city_id", cityId),
  ])
  const daily = (dailyRes.data ?? []) as {
    source: SourceInput["source"]
    high_temp: number
    low_temp: number
    precipitation: number
    condition_category: string | null
  }[]
  const currentBySource = new Map<
    string,
    { humidity: number | null; wind_speed: number | null }
  >()
  for (const c of (currentRes.data ?? []) as {
    source: string
    humidity: number | null
    wind_speed: number
  }[]) {
    currentBySource.set(c.source, {
      humidity: c.humidity,
      wind_speed: c.wind_speed,
    })
  }

  const validCats = new Set<string>(conditionCategorySchema.options)
  const inputs: SourceInput[] = []
  for (const d of daily) {
    const cur = currentBySource.get(d.source)
    inputs.push({
      source: d.source,
      high: d.high_temp,
      low: d.low_temp,
      precip: d.precipitation,
      // 归一分类在入库时已保证合法，这里防御性校验，非法归 null（不参与投票）
      condition:
        d.condition_category && validCats.has(d.condition_category)
          ? (d.condition_category as ConditionCategory)
          : null,
      humidity: cur?.humidity ?? null,
      windMs: cur?.wind_speed ?? null,
    })
  }
  return inputs
}
