import { z } from "zod"

import type {
  CityPoint,
  ForecastItem,
  NormalizedWeather,
  WeatherPoint,
} from "@/lib/schemas/weather"
import { normalizedWeatherSchema } from "@/lib/schemas/weather"
import { fetchJson } from "@/lib/weather/http"
import { mapOwmCode } from "@/lib/weather/mapping"

import type { AdapterResult, ProviderAdapter } from "./index"

// OpenWeatherMap 免费档 2.5：实时 /weather + 预报 /forecast 两次调用，
// units=metric → 温度 °C、风速 m/s、气压 hPa、降水 mm
const API_BASE = "https://api.openweathermap.org/data/2.5"

// 实时响应：main.temp 必在，weather 至少一项，rain/snow 仅降水时出现
const owmCurrentSchema = z.object({
  dt: z.number(),
  main: z.object({
    temp: z.number(),
    feels_like: z.number().optional(),
    pressure: z.number().optional(),
    humidity: z.number().optional(),
  }),
  wind: z
    .object({
      speed: z.number(),
      deg: z.number().optional(),
    })
    .optional(),
  weather: z
    .array(
      z.object({ id: z.number(), main: z.string(), description: z.string() })
    )
    .min(1)
    .optional(),
  rain: z.object({ "1h": z.number() }).optional(),
  snow: z.object({ "1h": z.number() }).optional(),
})

// 预报单条：结构与实时近似，降水用 3h 窗口
const owmForecastItemSchema = z.object({
  dt: z.number(),
  main: z.object({
    temp: z.number(),
    feels_like: z.number().optional(),
    pressure: z.number().optional(),
    humidity: z.number().optional(),
  }),
  wind: z
    .object({
      speed: z.number(),
      deg: z.number().optional(),
    })
    .optional(),
  weather: z
    .array(
      z.object({ id: z.number(), main: z.string(), description: z.string() })
    )
    .min(1)
    .optional(),
  rain: z.object({ "3h": z.number() }).optional(),
  snow: z.object({ "3h": z.number() }).optional(),
})

const owmForecastSchema = z.object({
  list: z.array(owmForecastItemSchema),
})

// 实时 → canonical 单点；weather 缺省按 -1 处理（category 归 other）
function mapCurrentPoint(raw: z.infer<typeof owmCurrentSchema>): WeatherPoint {
  const weather = raw.weather?.[0]
  const code = weather?.id ?? -1
  return {
    temperature: raw.main.temp,
    feelsLike: raw.main.feels_like,
    humidity: raw.main.humidity,
    pressure: raw.main.pressure,
    windSpeed: raw.wind?.speed ?? 0,
    windDirection: raw.wind?.deg,
    precipitation: raw.rain?.["1h"] ?? raw.snow?.["1h"] ?? 0,
    conditionCode: code,
    conditionLabel: weather?.description ?? "Unknown",
    conditionCategory: mapOwmCode(code),
    observedAt: new Date(raw.dt * 1000).toISOString(),
  }
}

// 预报条目 → canonical 预报项；dt 是 UTC epoch，无需时区换算
function mapForecastItem(
  raw: z.infer<typeof owmForecastItemSchema>
): ForecastItem {
  const weather = raw.weather?.[0]
  const code = weather?.id ?? -1
  return {
    temperature: raw.main.temp,
    feelsLike: raw.main.feels_like,
    humidity: raw.main.humidity,
    pressure: raw.main.pressure,
    windSpeed: raw.wind?.speed ?? 0,
    windDirection: raw.wind?.deg,
    precipitation: raw.rain?.["3h"] ?? raw.snow?.["3h"] ?? 0,
    conditionCode: code,
    conditionLabel: weather?.description ?? "Unknown",
    conditionCategory: mapOwmCode(code),
    observedAt: new Date(raw.dt * 1000).toISOString(),
    forecastTime: new Date(raw.dt * 1000).toISOString(),
  }
}

// OpenWeatherMap 适配器：两个端点并行请求，任一失败该格整体失败
export const openWeather: ProviderAdapter = {
  source: "openweather",

  async fetchCurrentAndForecast(city: CityPoint): Promise<AdapterResult> {
    const key = process.env.OPENWEATHER_API_KEY
    if (!key) return { ok: false, error: "missingKey" }

    const query = `lat=${city.latitude}&lon=${city.longitude}&units=metric&appid=${key}`
    const [curRes, fcRes] = await Promise.all([
      fetchJson(`${API_BASE}/weather?${query}`),
      fetchJson(`${API_BASE}/forecast?${query}`),
    ])
    if (!curRes.ok) return { ok: false, error: curRes.error }
    if (!fcRes.ok) return { ok: false, error: fcRes.error }

    const curParsed = owmCurrentSchema.safeParse(curRes.json)
    if (!curParsed.success) return { ok: false, error: "parse" }
    const fcParsed = owmForecastSchema.safeParse(fcRes.json)
    if (!fcParsed.success) return { ok: false, error: "parse" }

    const data: NormalizedWeather = {
      city,
      source: "openweather",
      current: mapCurrentPoint(curParsed.data),
      forecast: fcParsed.data.list.map(mapForecastItem),
      fetchedAt: new Date().toISOString(),
      raw: { current: curRes.json, forecast: fcRes.json },
    }
    const check = normalizedWeatherSchema.safeParse(data)
    if (!check.success) return { ok: false, error: "parse" }
    return { ok: true, data: check.data }
  },
}
