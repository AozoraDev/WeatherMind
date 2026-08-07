import { z } from "zod"

import type {
  CityPoint,
  ForecastItem,
  NormalizedWeather,
  WeatherPoint,
} from "@/lib/schemas/weather"
import { normalizedWeatherSchema } from "@/lib/schemas/weather"
import { daysAgoLocalDateKey } from "@/lib/weather/daily"
import { fetchJson } from "@/lib/weather/http"
import { kphToMps, mapWeatherApiCode } from "@/lib/weather/mapping"

import type {
  AdapterResult,
  HistoryDay,
  HistoryResult,
  ProviderAdapter,
} from "./index"

// WeatherAPI.com：实时 /current + 预报 /forecast（days=3）两次调用，
// 温度为 °C、气压为 mb（与 hPa 数值相同），风速 km/h 需转 m/s
const API_BASE = "https://api.weatherapi.com/v1"

// condition 结构两处共用
const waConditionSchema = z.object({ text: z.string(), code: z.number() })

const waCurrentSchema = z.object({
  current: z.object({
    last_updated_epoch: z.number(),
    temp_c: z.number(),
    feelslike_c: z.number().optional(),
    humidity: z.number().optional(),
    pressure_mb: z.number().optional(),
    wind_kph: z.number().optional(),
    wind_degree: z.number().optional(),
    precip_mm: z.number().optional(),
    condition: waConditionSchema,
  }),
})

// 预报：forecastday[].hour[] 展开为平铺序列
const waHourSchema = z.object({
  time_epoch: z.number(),
  temp_c: z.number(),
  feelslike_c: z.number().optional(),
  humidity: z.number().optional(),
  pressure_mb: z.number().optional(),
  wind_kph: z.number().optional(),
  wind_degree: z.number().optional(),
  precip_mm: z.number().optional(),
  condition: waConditionSchema,
})

const waForecastSchema = z.object({
  forecast: z.object({
    forecastday: z.array(z.object({ hour: z.array(waHourSchema) })),
  }),
})

// 历史响应：history.json 单日返回一个 forecastday，日汇总取 day 字段（最高/最低温、
// 降水累计、condition），不回填逐小时
const waHistorySchema = z.object({
  forecast: z.object({
    forecastday: z.array(
      z.object({
        day: z.object({
          maxtemp_c: z.number(),
          mintemp_c: z.number(),
          totalprecip_mm: z.number().optional(),
          condition: waConditionSchema,
        }),
      })
    ),
  }),
})

// 实时 → canonical 单点；时间用 epoch，不解析 "2026-08-06 15:00" 这类无时区字符串
function mapCurrentPoint(raw: z.infer<typeof waCurrentSchema>): WeatherPoint {
  const cond = raw.current.condition
  return {
    temperature: raw.current.temp_c,
    feelsLike: raw.current.feelslike_c,
    humidity: raw.current.humidity,
    pressure: raw.current.pressure_mb,
    windSpeed: kphToMps(raw.current.wind_kph ?? 0),
    windDirection: raw.current.wind_degree,
    precipitation: raw.current.precip_mm ?? 0,
    conditionCode: cond.code,
    conditionLabel: cond.text,
    conditionCategory: mapWeatherApiCode(cond.code),
    observedAt: new Date(raw.current.last_updated_epoch * 1000).toISOString(),
  }
}

// 预报小时项 → canonical 预报项
function mapForecastItem(raw: z.infer<typeof waHourSchema>): ForecastItem {
  const cond = raw.condition
  return {
    temperature: raw.temp_c,
    feelsLike: raw.feelslike_c,
    humidity: raw.humidity,
    pressure: raw.pressure_mb,
    windSpeed: kphToMps(raw.wind_kph ?? 0),
    windDirection: raw.wind_degree,
    precipitation: raw.precip_mm ?? 0,
    conditionCode: cond.code,
    conditionLabel: cond.text,
    conditionCategory: mapWeatherApiCode(cond.code),
    observedAt: new Date(raw.time_epoch * 1000).toISOString(),
    forecastTime: new Date(raw.time_epoch * 1000).toISOString(),
  }
}

// 历史日汇总 → 回填单日；day 用请求传入的本地日期键（不信任源返回的 naive 日期）
function mapHistoryDay(
  raw: z.infer<typeof waHistorySchema>,
  day: string
): HistoryDay {
  const sum = raw.forecast.forecastday[0].day
  return {
    day,
    highTemp: sum.maxtemp_c,
    lowTemp: sum.mintemp_c,
    precipitation: sum.totalprecip_mm ?? 0,
    conditionCode: sum.condition.code,
    conditionLabel: sum.condition.text,
    conditionCategory: mapWeatherApiCode(sum.condition.code),
  }
}

// WeatherAPI.com 适配器：两个端点并行请求
export const weatherApi: ProviderAdapter = {
  source: "weatherapi",

  async fetchCurrentAndForecast(city: CityPoint): Promise<AdapterResult> {
    const key = process.env.WEATHERAPI_API_KEY
    if (!key) return { ok: false, error: "missingKey" }

    const q = `${city.latitude},${city.longitude}`
    const [curRes, fcRes] = await Promise.all([
      fetchJson(`${API_BASE}/current.json?key=${key}&q=${q}`),
      fetchJson(`${API_BASE}/forecast.json?key=${key}&q=${q}&days=3`),
    ])
    if (!curRes.ok) return { ok: false, error: curRes.error }
    if (!fcRes.ok) return { ok: false, error: fcRes.error }

    const curParsed = waCurrentSchema.safeParse(curRes.json)
    if (!curParsed.success) return { ok: false, error: "parse" }
    const fcParsed = waForecastSchema.safeParse(fcRes.json)
    if (!fcParsed.success) return { ok: false, error: "parse" }

    const data: NormalizedWeather = {
      city,
      source: "weatherapi",
      current: mapCurrentPoint(curParsed.data),
      forecast: fcParsed.data.forecast.forecastday.flatMap((d) =>
        d.hour.map(mapForecastItem)
      ),
      fetchedAt: new Date().toISOString(),
      raw: { current: curRes.json, forecast: fcRes.json },
    }
    const check = normalizedWeatherSchema.safeParse(data)
    if (!check.success) return { ok: false, error: "parse" }
    return { ok: true, data: check.data }
  },

  // 历史回填：history.json 逐天查（单日返回一个 forecastday），
  // 任一天失败整格失败，由调用方计入回填摘要
  async fetchDailyHistory(
    city: CityPoint,
    days: number
  ): Promise<HistoryResult> {
    const key = process.env.WEATHERAPI_API_KEY
    if (!key) return { ok: false, error: "missingKey" }

    const q = `${city.latitude},${city.longitude}`
    const daily: HistoryDay[] = []
    for (let i = days - 1; i >= 0; i--) {
      const dayKey = daysAgoLocalDateKey(city.timezone, i)
      const res = await fetchJson(
        `${API_BASE}/history.json?key=${key}&q=${q}&dt=${dayKey}`
      )
      if (!res.ok) return { ok: false, error: res.error }
      const parsed = waHistorySchema.safeParse(res.json)
      if (!parsed.success) return { ok: false, error: "parse" }
      if (!parsed.data.forecast.forecastday[0])
        return { ok: false, error: "noData" }
      daily.push(mapHistoryDay(parsed.data, dayKey))
    }
    return { ok: true, daily }
  },
}
