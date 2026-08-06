import type { ConditionCategory } from "@/lib/schemas/weather"

// 条件码 → 归一粗分类：跨源比较只依赖粗分类，不依赖各源各自的细分码。
// 映射依据各源公开的天气代码定义，只做粗分不追求穷举（见各函数注释）

// WMO 码（Open-Meteo 直接透传）：0 晴、1-3 多云、45/48 雾、
// 51-67 毛毛雨/雨、71-77 雪、80-82 阵雨、85/86 阵雪、95-99 雷暴
export function mapWmoCode(code: number): ConditionCategory {
  if (code === 0) return "clear"
  if (code >= 1 && code <= 3) return "partlyCloudy"
  if (code === 45 || code === 48) return "fog"
  if (
    (code >= 51 && code <= 57) ||
    (code >= 61 && code <= 67) ||
    (code >= 80 && code <= 82)
  ) {
    return "rain"
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow"
  if (code === 95 || code === 96 || code === 99) return "storm"
  return "other"
}

// OWM 码按 id 前缀分区：2xx 雷暴、3xx/5xx 雨、6xx 雪、7xx 雾/霾、
// 800 晴、801-802 多云间晴、803-804 阴
export function mapOwmCode(code: number): ConditionCategory {
  if (code >= 200 && code < 300) return "storm"
  if (code >= 300 && code < 600) return "rain"
  if (code >= 600 && code < 700) return "snow"
  if (code >= 700 && code < 800) return "fog"
  if (code === 800) return "clear"
  if (code === 801 || code === 802) return "partlyCloudy"
  if (code === 803 || code === 804) return "cloudy"
  return "other"
}

// WeatherAPI.com 码：1000 晴、1003 多云间晴、1006/1009 阴、
// 1030/1135/1147 雾、1087/1273/1276 雷暴，其余雨/雪按码枚举（粗分）
const WEATHER_API_RAIN_CODES = [
  1063, 1072, 1150, 1153, 1168, 1171, 1180, 1183, 1186, 1189, 1192, 1195, 1198,
  1201, 1237, 1240, 1243, 1246,
]
const WEATHER_API_SNOW_CODES = [
  1066, 1069, 1114, 1117, 1204, 1207, 1210, 1213, 1216, 1219, 1222, 1225, 1249,
  1252, 1255, 1258, 1261, 1264, 1279, 1282,
]
const WEATHER_API_STORM_CODES = [1087, 1273, 1276]
const WEATHER_API_FOG_CODES = [1030, 1135, 1147]

export function mapWeatherApiCode(code: number): ConditionCategory {
  if (code === 1000) return "clear"
  if (code === 1003) return "partlyCloudy"
  if (code === 1006 || code === 1009) return "cloudy"
  if (WEATHER_API_FOG_CODES.includes(code)) return "fog"
  if (WEATHER_API_STORM_CODES.includes(code)) return "storm"
  if (WEATHER_API_RAIN_CODES.includes(code)) return "rain"
  if (WEATHER_API_SNOW_CODES.includes(code)) return "snow"
  return "other"
}

// WeatherAPI 的风速单位是 km/h，统一换算成 m/s（3.6 km/h = 1 m/s）
export function kphToMps(kph: number): number {
  return Number((kph / 3.6).toFixed(2))
}
