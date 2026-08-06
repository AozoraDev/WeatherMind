import { z } from "zod"

// 天气 canonical schema：三个源（Open-Meteo / OpenWeatherMap / WeatherAPI.com）
// 归一化后的统一形态，供入库、展示、跨源对比使用
// 关键约定：
// - 时间统一为 UTC ISO 字符串（以 Z 结尾），避免各源本地时间 +9h 偏移
// - conditionCode / conditionLabel 保留各源自带值，不做跨源翻译；
//   跨源比较只看 conditionCategory（归一粗分类）

// 数据源判别
export const sourceSchema = z.enum(["open-meteo", "openweather", "weatherapi"])
export type WeatherSource = z.infer<typeof sourceSchema>

// 归一粗分类（跨源可比较），具体映射见 lib/weather/mapping.ts
export const conditionCategorySchema = z.enum([
  "clear",
  "partlyCloudy",
  "cloudy",
  "fog",
  "rain",
  "snow",
  "storm",
  "other",
])
export type ConditionCategory = z.infer<typeof conditionCategorySchema>

// CityPoint：adapter 消费的城市入参；内部可信数据，仅作类型来源不作运行时解析
export const cityPointSchema = z.object({
  id: z.string(), // 城市 uuid
  nameJa: z.string(),
  nameEn: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  timezone: z.string(), // 如 Asia/Tokyo
})
export type CityPoint = z.infer<typeof cityPointSchema>

// 归一化的天气状态（单点，实时或预报共用）
export const weatherPointSchema = z.object({
  temperature: z.number(), // 摄氏 °C
  feelsLike: z.number().optional(), // 体感 °C
  humidity: z.number().optional(), // 相对湿度 %
  pressure: z.number().optional(), // 海平面气压 hPa
  windSpeed: z.number(), // m/s（三个源都能给公制）
  windDirection: z.number().optional(), // 气象风向角 0-359
  precipitation: z.number(), // mm（无降水按 0 填）
  conditionCode: z.number(), // 各源自带的状态码，保留原值
  conditionLabel: z.string(), // 各源自带的文案（如 "Partly cloudy"）
  conditionCategory: conditionCategorySchema, // 归一粗分类
  observedAt: z.string(), // 观测时间，UTC ISO
})
export type WeatherPoint = z.infer<typeof weatherPointSchema>

// 预报项 = 天气状态 + 预报时刻
export const forecastItemSchema = weatherPointSchema.extend({
  forecastTime: z.string(), // 预报时刻，UTC ISO
})
export type ForecastItem = z.infer<typeof forecastItemSchema>

// 单源单城的归一化结果（adapter 的产物）
export const normalizedWeatherSchema = z.object({
  city: cityPointSchema,
  source: sourceSchema,
  current: weatherPointSchema,
  forecast: z.array(forecastItemSchema),
  fetchedAt: z.string(), // 拉取时刻 UTC ISO
  raw: z.unknown(), // 源原始响应全文（调试用，落库到 raw jsonb）
})
export type NormalizedWeather = z.infer<typeof normalizedWeatherSchema>
