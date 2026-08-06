import { z } from "zod"

import type {
  CityPoint,
  ForecastItem,
  NormalizedWeather,
  WeatherPoint,
} from "@/lib/schemas/weather"
import { normalizedWeatherSchema } from "@/lib/schemas/weather"
import { fetchJson } from "@/lib/weather/http"
import { mapWmoCode } from "@/lib/weather/mapping"

import type { AdapterResult, ProviderAdapter } from "./index"

// Open-Meteo 免 key、单次调用，返回 current + hourly；时区取城市时区，数值全用公制
const API_BASE = "https://api.open-meteo.com/v1/forecast"

// WMO 天气码 → 英文文案（Open-Meteo 不返回文案，这里粗分生成展示用 label）
const wmoLabels: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
}

// 当前时刻点：Open-Meteo 在缺计算值时省略字段，全部 optional，映射时兜底
const openMeteoCurrentSchema = z.object({
  time: z.string(),
  temperature_2m: z.number().optional(),
  relative_humidity_2m: z.number().optional(),
  apparent_temperature: z.number().optional(),
  precipitation: z.number().optional(),
  weather_code: z.number().optional(),
  pressure_msl: z.number().optional(),
  wind_speed_10m: z.number().optional(),
  wind_direction_10m: z.number().optional(),
})

// 逐小时序列：各数组按 time 索引对齐，缺计算值处对应索引缺项
const openMeteoHourlySchema = z.object({
  time: z.array(z.string()).optional(),
  temperature_2m: z.array(z.number()).optional(),
  relative_humidity_2m: z.array(z.number()).optional(),
  apparent_temperature: z.array(z.number()).optional(),
  precipitation: z.array(z.number()).optional(),
  weather_code: z.array(z.number()).optional(),
  pressure_msl: z.array(z.number()).optional(),
  wind_speed_10m: z.array(z.number()).optional(),
  wind_direction_10m: z.array(z.number()).optional(),
})

const openMeteoResponseSchema = z.object({
  utc_offset_seconds: z.number().optional(),
  current: openMeteoCurrentSchema.optional(),
  hourly: openMeteoHourlySchema.optional(),
})

// 把 naive 本地时间（如 "2026-08-06T15:00"，即请求时区本地时刻）换算成 UTC ISO。
// 不用 Date.parse：它按进程本地时区解释、结果依赖部署环境；这里按 UTC 组装再减偏移，
// 与运行时区无关（跳过这一步会存成 +9h 偏移的时间）
function toUtcIso(naive: string, offsetSeconds: number): string {
  const [date, time = "00:00"] = naive.split("T")
  const [y, m, d] = date.split("-").map(Number)
  const [hh, mm] = time.split(":").map(Number)
  return new Date(
    Date.UTC(y, m - 1, d, hh, mm) - offsetSeconds * 1000
  ).toISOString()
}

// 当前时刻 → canonical 单点；必需字段缺失视为无数据（返回 null）
function mapCurrentPoint(
  raw: z.infer<typeof openMeteoCurrentSchema>,
  offset: number
): WeatherPoint | null {
  if (
    raw.temperature_2m == null ||
    raw.wind_speed_10m == null ||
    raw.weather_code == null
  ) {
    return null
  }
  const code = raw.weather_code
  return {
    temperature: raw.temperature_2m,
    feelsLike: raw.apparent_temperature,
    humidity: raw.relative_humidity_2m,
    pressure: raw.pressure_msl,
    windSpeed: raw.wind_speed_10m,
    windDirection: raw.wind_direction_10m,
    precipitation: raw.precipitation ?? 0,
    conditionCode: code,
    conditionLabel: wmoLabels[code] ?? "Unknown",
    conditionCategory: mapWmoCode(code),
    observedAt: toUtcIso(raw.time, offset),
  }
}

// 逐小时数组 → canonical 预报项列表；某索引缺必需值则跳过该条
function mapForecastItems(
  raw: z.infer<typeof openMeteoHourlySchema>,
  offset: number
): ForecastItem[] {
  const items: ForecastItem[] = []
  for (let i = 0; i < (raw.time?.length ?? 0); i++) {
    const t = raw.time?.[i]
    const temp = raw.temperature_2m?.[i]
    const wind = raw.wind_speed_10m?.[i]
    const code = raw.weather_code?.[i]
    if (t == null || temp == null || wind == null || code == null) continue
    items.push({
      temperature: temp,
      feelsLike: raw.apparent_temperature?.[i],
      humidity: raw.relative_humidity_2m?.[i],
      pressure: raw.pressure_msl?.[i],
      windSpeed: wind,
      windDirection: raw.wind_direction_10m?.[i],
      precipitation: raw.precipitation?.[i] ?? 0,
      conditionCode: code,
      conditionLabel: wmoLabels[code] ?? "Unknown",
      conditionCategory: mapWmoCode(code),
      observedAt: toUtcIso(t, offset),
      forecastTime: toUtcIso(t, offset),
    })
  }
  return items
}

// Open-Meteo 适配器：单次调用拿实时 + 逐小时预报
export const openMeteo: ProviderAdapter = {
  source: "open-meteo",

  async fetchCurrentAndForecast(city: CityPoint): Promise<AdapterResult> {
    const params = new URLSearchParams({
      latitude: String(city.latitude),
      longitude: String(city.longitude),
      current:
        "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m",
      hourly:
        "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m",
      forecast_days: "3",
      timezone: city.timezone,
      temperature_unit: "celsius",
      wind_speed_unit: "ms",
      precipitation_unit: "mm",
    })

    const res = await fetchJson(`${API_BASE}?${params}`)
    if (!res.ok) return { ok: false, error: res.error }

    const parsed = openMeteoResponseSchema.safeParse(res.json)
    if (!parsed.success) return { ok: false, error: "parse" }
    if (!parsed.data.current) return { ok: false, error: "noData" }

    // 缺省按 Asia/Tokyo 偏移（无夏令时），API 正常情况下会返回 utc_offset_seconds
    const offset = parsed.data.utc_offset_seconds ?? 32400
    const current = mapCurrentPoint(parsed.data.current, offset)
    if (!current) return { ok: false, error: "noData" }

    const forecast = parsed.data.hourly
      ? mapForecastItems(parsed.data.hourly, offset)
      : []

    const data: NormalizedWeather = {
      city,
      source: "open-meteo",
      current,
      forecast,
      fetchedAt: new Date().toISOString(),
      raw: parsed.data,
    }
    const check = normalizedWeatherSchema.safeParse(data)
    if (!check.success) return { ok: false, error: "parse" }
    return { ok: true, data: check.data }
  },
}
