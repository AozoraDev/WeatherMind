import type { WeatherSource } from "@/lib/schemas/weather"
import type { ForecastDbRow } from "@/lib/schemas/forecast-agent"

// 展示层 DB 行类型：无生成 Database 类型，服务端查询结果在此边界断言为强类型。
// 字段与 supabase/migrations/0001_weather.sql 的表结构对应（snake_case）

export type CityRow = {
  id: string
  name_ja: string
  name_en: string
  latitude: number
  longitude: number
  timezone: string
  is_active: boolean
}

export type CurrentRow = {
  id: string
  city_id: string
  source: WeatherSource
  observed_at: string
  temperature: number
  feels_like: number | null
  humidity: number | null
  pressure: number | null
  wind_speed: number
  wind_direction: number | null
  precipitation: number
  condition_code: number | null
  condition_label: string | null
  condition_category: string | null
  updated_at: string
}

export type DailyRow = {
  id: string
  city_id: string
  source: WeatherSource
  day: string // YYYY-MM-DD（城市本地日）
  high_temp: number
  low_temp: number
  temperature: number
  precipitation: number
  condition_code: number | null
  condition_label: string | null
  condition_category: string | null
  updated_at: string
}

export type RunRow = {
  id: string
  status: string
  trigger: string
  total_cells: number
  succeeded_cells: number
  failed_cells: number
  error: string | null
  started_at: string
  finished_at: string | null
}

// ForecastAgent 预测行：类型单一来源在 schemas/forecast-agent.ts（ForecastDbRow），
// 展示层在此 re-export，避免两处定义漂移
export type ForecastRow = ForecastDbRow

export type TruthRow = {
  id: string
  city_id: string
  day: string
  observed_high: number
  observed_low: number
  observed_precip: number
  sources_used: number
}
