import type { ConditionCategory } from "@/lib/schemas/weather"
import type {
  CityPoint,
  NormalizedWeather,
  WeatherSource,
} from "@/lib/schemas/weather"

import { openMeteo } from "./open-meteo"
import { openWeather } from "./openweather"
import { weatherApi } from "./weatherapi"

// 单源单城拉取结果：成功返回归一化数据，失败返回受限错误码（绝不抛错）
export type AdapterErrorCode =
  "missingKey" | "network" | "http" | "parse" | "noData"

export type AdapterResult =
  { ok: true; data: NormalizedWeather } | { ok: false; error: AdapterErrorCode }

// 历史回填的单日行：条件列可空——OWM day_summary 端点不含天气状况字段，
// 该源回填时置 null（表列可空，历史表格/图表对 null 均有兜底）
export type HistoryDay = {
  day: string // 城市本地日期 YYYY-MM-DD
  highTemp: number
  lowTemp: number
  precipitation: number
  conditionCode: number | null
  conditionLabel: string | null
  conditionCategory: ConditionCategory | null
}

// 单源单城历史回填结果：成功返回近 days 天（含今天）的每日聚合
export type HistoryResult =
  { ok: true; daily: HistoryDay[] } | { ok: false; error: AdapterErrorCode }

// 适配器契约：每个数据源实现一份，pipeline 按序遍历 city × provider
export type ProviderAdapter = {
  source: WeatherSource
  fetchCurrentAndForecast: (city: CityPoint) => Promise<AdapterResult>
  // 历史回填：拉取近 days 天（含今天）的每日聚合，day 为城市本地日
  fetchDailyHistory: (city: CityPoint, days: number) => Promise<HistoryResult>
}

// 注册表：Open-Meteo 免 key 恒在，pipeline 对每城逐个调用
export const providers: ProviderAdapter[] = [openMeteo, openWeather, weatherApi]
