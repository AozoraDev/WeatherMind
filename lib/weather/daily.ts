import type {
  ConditionCategory,
  ForecastItem,
  WeatherPoint,
} from "@/lib/schemas/weather"

// 单日聚合（来自当日预报 slot；temperature 采集快照由调用方并入，不在此计算）
export type DailyAggregate = {
  day: string // 城市本地日期 YYYY-MM-DD
  highTemp: number // 当日最高温 °C
  lowTemp: number // 当日最低温 °C
  precipitation: number // 当日降水累计 mm
  conditionCode: number // 当日最高温 slot 的条件码（保留源值）
  conditionLabel: string // 当日最高温 slot 的条件文案
  conditionCategory: ConditionCategory // 当日最高温 slot 的归一粗分类
}

// UTC ISO 时刻 → 指定时区本地日期键（YYYY-MM-DD）。
// 用 formatToParts 显式取年月日，避免各环境 Intl 输出格式差异；
// 不用 Date.parse（按进程本地时区，跨环境不一致），不用 getUTCDate（丢城市时区）
export function toLocalDateKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

// 把该城预报 slot 按城市本地日分桶聚合：
// high=当日最高温、low=当日最低温、precipitation=求和；
// condition* 取当日温度最高 slot 作为代表天气（并列取先出现者）
export function aggregateDailyForecast(
  timeZone: string,
  forecast: ForecastItem[]
): Map<string, DailyAggregate> {
  const buckets = new Map<string, DailyAggregate>()
  for (const item of forecast) {
    const day = toLocalDateKey(item.forecastTime, timeZone)
    const existing = buckets.get(day)
    if (!existing) {
      buckets.set(day, {
        day,
        highTemp: item.temperature,
        lowTemp: item.temperature,
        precipitation: item.precipitation,
        conditionCode: item.conditionCode,
        conditionLabel: item.conditionLabel,
        conditionCategory: item.conditionCategory,
      })
      continue
    }
    // 严格大于才更新代表天气：保证温度并列时保留先出现者
    if (item.temperature > existing.highTemp) {
      existing.conditionCode = item.conditionCode
      existing.conditionLabel = item.conditionLabel
      existing.conditionCategory = item.conditionCategory
    }
    existing.highTemp = Math.max(existing.highTemp, item.temperature)
    existing.lowTemp = Math.min(existing.lowTemp, item.temperature)
    existing.precipitation += item.precipitation
  }
  return buckets
}

// 指定时区「今天」的本地日期键；now 供测试注入（默认取真实当前时刻）
// 仅本模块内部（todayAggregate / recentWindow）使用，不对外暴露
function localTodayKey(
  timeZone: string,
  now: Date = new Date()
): string {
  return toLocalDateKey(now.toISOString(), timeZone)
}

// 当日快照聚合：预报含当天 slot 用预报聚合，否则用实时数据兜底。
// 兜底场景：OWM 免费档 3h 粒度从下一个整点边界起步，本地午夜后拉取当天无 slot，
// 静默跳过会导致历史页当天缺该源数据；兜底保证 城×源×日 当天必有一行，
// 后续白天跑到含当天 slot 的预报时由 upsert 覆盖为真实聚合
export function todayAggregate(
  timeZone: string,
  fetchedAt: string,
  forecast: ForecastItem[],
  current: WeatherPoint
): DailyAggregate {
  const today = localTodayKey(timeZone, new Date(fetchedAt))
  return (
    aggregateDailyForecast(timeZone, forecast).get(today) ?? {
      day: today,
      highTemp: current.temperature,
      lowTemp: current.temperature,
      precipitation: current.precipitation,
      conditionCode: current.conditionCode,
      conditionLabel: current.conditionLabel,
      conditionCategory: current.conditionCategory,
    }
  )
}

// 指定时区「今天」往前 N 天的本地日期键（历史页查询下界与清理边界共用）。
// 天数运算直接用 Date 毫秒偏移；6 天内无 DST 跳变，近似足够
export function daysAgoLocalDateKey(
  timeZone: string,
  days: number,
  now: Date = new Date()
): string {
  return toLocalDateKey(
    new Date(now.getTime() - days * 86_400_000).toISOString(),
    timeZone
  )
}

// 近 days 天（含今天）的城市本地日期窗口 [from, to]，含边界。
// 供历史回填界定范围：adapter 只产出窗口内每日聚合、回填主流程统一按此过滤
export function recentWindow(
  timeZone: string,
  days: number,
  now: Date = new Date()
): { from: string; to: string } {
  return {
    to: localTodayKey(timeZone, now),
    from: daysAgoLocalDateKey(timeZone, days - 1, now),
  }
}
