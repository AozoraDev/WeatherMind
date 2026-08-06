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

// 适配器契约：每个数据源实现一份，pipeline 按序遍历 city × provider
export type ProviderAdapter = {
  source: WeatherSource
  fetchCurrentAndForecast: (city: CityPoint) => Promise<AdapterResult>
}

// 注册表：Open-Meteo 免 key 恒在，pipeline 对每城逐个调用
export const providers: ProviderAdapter[] = [openMeteo, openWeather, weatherApi]
