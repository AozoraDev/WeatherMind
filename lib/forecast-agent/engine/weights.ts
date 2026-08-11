import type { SupabaseClient } from "@supabase/supabase-js"

import { toLocalDateKey } from "@/lib/weather/daily"
import { sourceSchema, type WeatherSource } from "@/lib/schemas/weather"

// 源权重：先验 + 一致性 + 真值MAE 三层合成，近 N 天滚动重算。
// 真值未积累时以先验为主；一致性分不依赖真值（留一法偏离度）；
// 真值攒够后 MAE 逐步接管（见 blendParams 的 α/β/γ 过渡）。
// 约定：一致性/MAE 用 Partial，undefined = 该源无样本，blend 时回退到先验（中性），
//       避免「无数据」被当成「完全一致」从而稀释先验比例。

// 源列表单一来源：取 sourceSchema.options（prompt/tools 同源），顺序固定保证确定性
export const SOURCES: readonly WeatherSource[] = sourceSchema.options

// 先验权重：基于模型已知技能（Open-Meteo 底层 GFS/ICON/ECMWF，静态基准）
export const PRIOR: Record<WeatherSource, number> = {
  "open-meteo": 0.5,
  openweather: 0.3,
  weatherapi: 0.2,
}

// 每个源的可信度采样：undefined = 无样本
export type SourceScore = Partial<Record<WeatherSource, number>>

export type WeightsDetail = {
  alpha: number
  beta: number
  gamma: number
  prior: Record<WeatherSource, number>
  consistency: SourceScore
  mae: SourceScore
}

export type Weights = Record<WeatherSource, number> & { detail: WeightsDetail }

// 中位数：空数组返回 0（真值/一致性计算共用）
export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

// 东京时刻 → YYYY-MM-DD 键（权重窗口的日期下界/上界用，粗粒度即可）。
// weather_daily.day 存的是城市本地日（全为 Asia/Tokyo，由 0011 迁移 CHECK 约束强制），
// 窗口边界必须与之一致；否则 JST 凌晨（UTC 前一日 15:00 后）UTC 日期键会落后一天，漏掉当天已落库的行
function toJstDateKey(d: Date): string {
  return toLocalDateKey(d.toISOString(), "Asia/Tokyo")
}

// —— 一致性分（纯函数，无真值） ——
// 对每个 城×日，某源偏离「另外两源中位数」的平均绝对偏差；越高越爱跑偏
type ConsRow = {
  city_id: string
  day: string
  source: WeatherSource
  high_temp: number
}

export function scoreConsistency(rows: ConsRow[]): SourceScore {
  const groups = new Map<string, { source: WeatherSource; high: number }[]>()
  for (const r of rows) {
    const key = `${r.city_id}:${r.day}`
    const list = groups.get(key) ?? []
    list.push({ source: r.source, high: r.high_temp })
    groups.set(key, list)
  }

  const acc: Record<WeatherSource, { sum: number; count: number }> = {
    "open-meteo": { sum: 0, count: 0 },
    openweather: { sum: 0, count: 0 },
    weatherapi: { sum: 0, count: 0 },
  }
  for (const list of groups.values()) {
    for (const item of list) {
      const others = list
        .filter((x) => x.source !== item.source)
        .map((x) => x.high)
      if (others.length === 0) continue
      const entry = acc[item.source]
      entry.sum += Math.abs(item.high - median(others))
      entry.count += 1
    }
  }

  const out: SourceScore = {}
  for (const s of SOURCES) {
    const e = acc[s]
    if (e.count > 0) out[s] = e.sum / e.count
  }
  return out
}

// 滚动窗口一致性分：查近 days 天 weather_daily 后交给纯函数
export async function consistencyScore(
  supabase: SupabaseClient,
  now: Date = new Date(),
  days = 6
): Promise<SourceScore> {
  const to = toJstDateKey(now)
  const from = toJstDateKey(new Date(now.getTime() - (days - 1) * 86_400_000))
  const { data, error } = await supabase
    .from("weather_daily")
    .select("city_id, day, source, high_temp")
    .gte("day", from)
    .lte("day", to)
  if (error || !data) return {}
  return scoreConsistency(data as ConsRow[])
}

// —— 真值 MAE（纯函数） ——
// 用 weather_truth 参考真值对账各源当日预报高温，算平均绝对误差
type TruthRow = { city_id: string; day: string; observed_high: number }
type DailyTruthRow = {
  city_id: string
  day: string
  source: WeatherSource
  high_temp: number
}

export function computeMae(
  truth: TruthRow[],
  daily: DailyTruthRow[]
): { mae: SourceScore; truthDays: number } {
  const observed = new Map<string, number>()
  for (const t of truth) observed.set(`${t.city_id}:${t.day}`, t.observed_high)

  const acc: Record<WeatherSource, { sum: number; count: number }> = {
    "open-meteo": { sum: 0, count: 0 },
    openweather: { sum: 0, count: 0 },
    weatherapi: { sum: 0, count: 0 },
  }
  const days = new Set<string>()
  for (const d of daily) {
    const obs = observed.get(`${d.city_id}:${d.day}`)
    if (obs == null) continue
    days.add(`${d.city_id}:${d.day}`)
    const entry = acc[d.source]
    entry.sum += Math.abs(d.high_temp - obs)
    entry.count += 1
  }

  const mae: SourceScore = {}
  for (const s of SOURCES) {
    const e = acc[s]
    if (e.count > 0) mae[s] = e.sum / e.count
  }
  return { mae, truthDays: days.size }
}

export async function truthMae(
  supabase: SupabaseClient,
  now: Date = new Date(),
  days = 31
): Promise<{ mae: SourceScore; truthDays: number }> {
  // 只回看近 days 天对账：MAE 分档到 ≥30 天即够，超窗历史无意义。
  // 与 consistencyScore 同样按东京日对齐窗口，避免全表扫描——weather_daily 不轮换
  //（供历史页展示），不加窗口会随数据积累越来越慢
  const to = toJstDateKey(now)
  const from = toJstDateKey(new Date(now.getTime() - (days - 1) * 86_400_000))
  const [truthRes, dailyRes] = await Promise.all([
    supabase
      .from("weather_truth")
      .select("city_id, day, observed_high")
      .gte("day", from)
      .lte("day", to),
    supabase
      .from("weather_daily")
      .select("city_id, day, source, high_temp")
      .gte("day", from)
      .lte("day", to),
  ])
  if (truthRes.error || !truthRes.data) return { mae: {}, truthDays: 0 }
  return computeMae(
    truthRes.data as TruthRow[],
    (dailyRes.data ?? []) as DailyTruthRow[]
  )
}

// —— α/β/γ 过渡 ——
// 真值天数越多，先验占比越低、MAE 越主导；<7 天几乎全依赖先验+一致性
export function blendParams(truthDays: number): {
  alpha: number
  beta: number
  gamma: number
} {
  if (truthDays >= 30) return { alpha: 0.1, beta: 0.1, gamma: 0.8 }
  if (truthDays >= 7) return { alpha: 0.3, beta: 0.2, gamma: 0.5 }
  return { alpha: 0.7, beta: 0.3, gamma: 0 }
}

// 三层合成并归一化（纯函数）。无样本的源回退到先验作为中性值：
// 一致性越大越差→取 1/(1+dev)；MAE 同理；先验降权/接管由 α/β/γ 控制
export function blendWeights(
  truthDays: number,
  prior: Record<WeatherSource, number>,
  consistency: SourceScore,
  mae: SourceScore
): Weights {
  const { alpha, beta, gamma } = blendParams(truthDays)
  const raw: Record<WeatherSource, number> = {
    "open-meteo": 0,
    openweather: 0,
    weatherapi: 0,
  }
  for (const s of SOURCES) {
    const p = prior[s] ?? 0
    const cons = consistency[s] == null ? p : 1 / (1 + consistency[s]!)
    const truthScore = mae[s] == null ? p : 1 / (1 + mae[s]!)
    raw[s] = alpha * p + beta * cons + gamma * truthScore
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0) || 1
  const weights = { "open-meteo": 0, openweather: 0, weatherapi: 0 }
  for (const s of SOURCES)
    weights[s] = Math.round((raw[s] / total) * 1000) / 1000
  return {
    ...weights,
    detail: { alpha, beta, gamma, prior, consistency, mae },
  }
}

// 每日重算的入口：并行取一致性分与真值 MAE，合成权重
export async function computeWeights(
  supabase: SupabaseClient
): Promise<Weights> {
  const [cons, truth] = await Promise.all([
    consistencyScore(supabase),
    truthMae(supabase),
  ])
  return blendWeights(truth.truthDays, PRIOR, cons, truth.mae)
}
