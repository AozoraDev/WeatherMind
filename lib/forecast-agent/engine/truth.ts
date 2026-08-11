import type { SupabaseClient } from "@supabase/supabase-js"

import type { CityPoint } from "@/lib/schemas/weather"
import { daysAgoLocalDateKey } from "@/lib/weather/daily"
import { providers } from "@/lib/weather/providers"

import { median } from "./weights"

// 参考真值采集：每天定时拉「昨天」各源历史观测，三源中位数作参考真值落库。
// 用途：与当天预报对账算各源 MAE，动态校准权重（见 weights.ts）。
// 说明：真值只是「接近真实」的工程近似——Open-Meteo past_days 是 ERA5 再分析、
// WeatherAPI 是站点观测；OWM 免费档无 history 则该源自动缺席，中位数照常取剩余源。

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

// 回填昨天真值：对每个启用城市逐源拉近 2 天历史，取昨天那天的观测，三源取中位数 upsert
export async function backfillTruth(supabase: SupabaseClient): Promise<{
  cities: number
  rows: number
}> {
  const { data: cityRows, error } = await supabase
    .from("cities")
    .select("*")
    .eq("is_active", true)
  if (error || !cityRows) return { cities: 0, rows: 0 }

  const cities = cityRows as CityRow[]
  let rows = 0
  for (const city of cities) {
    const cityPoint = toCityPoint(city)
    const yesterday = daysAgoLocalDateKey(city.timezone, 1)

    const values: { high: number; low: number; precip: number }[] = []
    for (const provider of providers) {
      // 拉近 2 天，取出「昨天」那天的每日聚合（各源 history 口径不一，统一按日取）
      const res = await provider.fetchDailyHistory(cityPoint, 2)
      if (!res.ok) continue
      const day = res.daily.find((d) => d.day === yesterday)
      if (!day) continue
      values.push({
        high: day.highTemp,
        low: day.lowTemp,
        precip: day.precipitation,
      })
    }
    if (values.length === 0) continue // 所有源都拿不到昨天的观测，跳过该城

    const { error: upsertError } = await supabase.from("weather_truth").upsert(
      {
        city_id: city.id,
        day: yesterday,
        observed_high: median(values.map((v) => v.high)),
        observed_low: median(values.map((v) => v.low)),
        observed_precip: median(values.map((v) => v.precip)),
        sources_used: values.length,
      },
      { onConflict: "city_id,day" }
    )
    if (!upsertError) rows += 1
  }

  // 真值轮换：只保留近一个月（MAE 分档到 ≥30 天即够，更早的历史对权重校准无意义）。
  // 表只增不减会随每天回填无限膨胀，故每次回填后清掉超窗旧行；清理失败不阻断主流程
  await pruneOldTruth(supabase)

  return { cities: cities.length, rows }
}

// 真值轮换：删除超过 keepDays 天的旧真值。day 键是城市本地日（全为 Asia/Tokyo，
// 由 0011 迁移 CHECK 约束强制），截止线按东京日取与之一致；清理为尽力而为，失败仅记日志（多留一天不影响分档，次日再清）
async function pruneOldTruth(
  supabase: SupabaseClient,
  now: Date = new Date(),
  keepDays = 31
): Promise<void> {
  const cutoff = daysAgoLocalDateKey("Asia/Tokyo", keepDays, now)
  const { error } = await supabase.from("weather_truth").delete().lt("day", cutoff)
  if (error) {
    console.error(`weather_truth 轮换删除失败：${error.message}`)
  }
}
