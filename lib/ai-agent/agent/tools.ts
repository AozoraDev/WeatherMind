import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { ReactTool } from "@/lib/agent-core/react"
import { readForecastForCity } from "@/lib/forecast-agent/db/db"
import { runForecastAgentStream } from "@/lib/forecast-agent/stream/stream"
import type { ForecastDbRow } from "@/lib/schemas/forecast-agent"
import { daysAgoLocalDateKey, toLocalDateKey } from "@/lib/weather/daily"

// 主 Agent 工具注册表：模型查城市/查各源快照（今日+历史）/查预报数据、以及把「生成预报」委托给子 Agent 的唯一入口。
// 五个工具都以 cityId/keyword 为入参（工具参数属不可信输入，execute 内用 zod 校验器兜底，
// 见 rules/zod-usage.md）；query_city/query_sources/query_weather_history/query_forecast 只读，generate_forecast 走 service 认领写。
// 委托链：query_city 定位 → 没问权威预报走 query_sources（今日逐源对比），问历史走 query_weather_history（近 7 天逐源），
// 问预报则 query_forecast 查数据 → 无数据则 generate_forecast（内部跑 ForecastAgent 全流程：读→认领→集成→子 Agent 生成→校验→落库），
// 主 Agent 拿观察结果组织回答。

export type MainAgentToolContext = {
  session: SupabaseClient // 认证读客户端（RLS）
  service: SupabaseClient // service_role 写客户端（认领/落库）
  email: string | null // 认领行 created_by；为空时 generate_forecast 拒绝
  // 下发给子 Agent 的模型连接（与主 Agent 同款）；只需 chat 调用子集，不需要 models 列表
  model: { baseUrl: string; apiKey: string; model: string }
  locale: "zh" | "en" // 预报文案语言（子 Agent 生成定稿时用）
  // 外部取消信号（客户端断开）：主 Agent 断线时子 Agent 生成随之中断，不继续烧 token
  signal?: AbortSignal
}

// 工具描述按语言：模型在 en 模式看到中文描述会被带偏输出中文，故 description 跟随 locale
const TOOL_DESCRIPTIONS: Record<
  "zh" | "en",
  {
    queryCity: string
    querySources: string
    queryWeatherHistory: string
    queryForecast: string
    generateForecast: string
  }
> = {
  zh: {
    queryCity:
      "按城市名（日文或英文）搜索平台支持的城市，返回城市 id、中/英文名与时区；无匹配返回空数组。",
    querySources:
      "查询某城市今日在 3 个数据源（open-meteo/openweather/weatherapi）各自的预报快照（高温/低温/降水/天气状况），用于逐源对比；尚未采集时返回 no-data。cityId 需来自 query_city。",
    queryWeatherHistory:
      "查询某城市近几日（最多 7 天，含今日）各数据源的历史每日快照（高温/低温/降水/天气状况），按城市本地日分组返回；平台仅保留近 7 天数据。cityId 需来自 query_city；days 为回看天数，不传默认 7。",
    queryForecast:
      "查询某城市今日的预报数据（温度/降水/风等权威指标）；尚未生成时返回 no-data。cityId 需来自 query_city。",
    generateForecast:
      "委托 ForecastAgent 子 Agent 生成（或获取已有的）某城市今日预报，返回权威指标。仅在 query_forecast 返回 no-data 时调用，耗时较长。cityId 需来自 query_city。",
  },
  en: {
    queryCity:
      "Search supported cities by name (Japanese or English); returns city id, names, and timezone. Empty array when no match.",
    querySources:
      "Read a city's per-source forecast snapshot for today from the 3 data sources (open-meteo/openweather/weatherapi): high/low, precipitation, condition — for cross-source comparison; returns no-data when not collected. cityId must come from query_city.",
    queryWeatherHistory:
      "Read a city's recent per-source daily snapshots (up to 7 days including today): high/low, precipitation, condition — grouped by local day; the platform keeps only the last 7 days. cityId must come from query_city; days is the lookback count, defaults to 7.",
    queryForecast:
      "Read a city's forecast for today (authoritative metrics); returns no-data when not generated. cityId must come from query_city.",
    generateForecast:
      "Delegate to the ForecastAgent sub-agent to generate (or fetch the existing) today's forecast for a city, returning authoritative metrics. Use only when query_forecast returns no-data; may take a while. cityId must come from query_city.",
  },
}

// 源显示名（与 i18n/messages 一致）：query_sources 观察里带 label，供模型直接引用源名，防编造
const SOURCE_LABELS: Record<string, string> = {
  "open-meteo": "Open-Meteo",
  openweather: "OpenWeatherMap",
  weatherapi: "WeatherAPI",
}

// 工具参数 zod 校验器与发往 API 的 JSON-schema（parameters）并置同形，防模型给出非法参数
const cityIdParam = z.object({ cityId: z.uuid("invalidInput") })
const keywordParam = z.object({ keyword: z.string().trim().min(1, "emptyMessage") })
// 历史窗口入参：days 为回看天数（含今日），平台仅保留近 7 天，越界拒绝而非静默截断
const historyParams = z.object({
  cityId: z.uuid("invalidInput"),
  days: z.number().int().min(1).max(7).optional(),
})

// ILIKE 通配符转义：`%`/`_`/`\` 在模式里按字面匹配，防用户输入被当成通配符；
// `,` 是 PostgREST `.or()` 的条件分隔符，模型问 "Tokyo, Japan" 时若不转义会把
// 过滤串切成多个条件导致查询失败，故一并按字面转义
function escapeIlike(keyword: string): string {
  return keyword.replace(/[\\%_,]/g, (ch) => `\\${ch}`)
}

// 成功行 → 观察结果：只提取结构化指标（不内联 markdown_body，保持观察精简，
// 主 Agent 依据指标自组织回答）。pending 行指标全 null，调用方按状态而非指标判断
function forecastRowToObservation(row: ForecastDbRow): Record<string, unknown> {
  return {
    status: "success",
    cityId: row.city_id,
    day: row.day,
    locale: row.locale,
    metrics: {
      predicted_high: row.predicted_high,
      predicted_low: row.predicted_low,
      high_interval: row.high_interval,
      low_interval: row.low_interval,
      precipitation_probability: row.precipitation_probability,
      precip_level: row.precip_level,
      condition: row.condition,
      wind_beaufort: row.wind_beaufort,
      humidity: row.humidity,
      confidence: row.confidence,
      risk_flags: row.risk_flags,
    },
  }
}

export function buildMainAgentTools(ctx: MainAgentToolContext): ReactTool[] {
  const { session, service, email, model, locale, signal } = ctx
  const desc = TOOL_DESCRIPTIONS[locale]

  return [
    {
      name: "query_city",
      description: desc.queryCity,
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", minLength: 1 } },
        required: ["keyword"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const parsed = keywordParam.safeParse(args)
        if (!parsed.success) {
          return JSON.stringify({ error: "invalid arguments: keyword is required" })
        }
        try {
          // 名字模糊匹配（日/英文均覆盖），只回活跃城市，最多 5 条供模型挑选
          const { data, error } = await session
            .from("cities")
            .select("id, name_ja, name_en, timezone")
            .or(
              `name_ja.ilike.%${escapeIlike(parsed.data.keyword)}%,name_en.ilike.%${escapeIlike(parsed.data.keyword)}%`
            )
            .eq("is_active", true)
            .limit(5)
          if (error) return JSON.stringify({ error: "city search failed" })
          return JSON.stringify({
            cities: (data ?? []) as {
              id: string
              name_ja: string
              name_en: string
              timezone: string
            }[],
          })
        } catch {
          return JSON.stringify({ error: "city search failed" })
        }
      },
    },
    {
      name: "query_sources",
      description: desc.querySources,
      parameters: {
        type: "object",
        properties: { cityId: { type: "string", format: "uuid" } },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const parsed = cityIdParam.safeParse(args)
        if (!parsed.success) {
          return JSON.stringify({
            error: "invalid arguments: cityId must be a uuid",
          })
        }
        try {
          // 先定位城市取时区算本地今日：weather_daily 按 城×源×城市本地日 存，
          // 与 query_forecast 的 readForecastForCity 同一套定位模式（防客户端时区漂移）。
          // 城市查询本身报错（非「不存在」）→ error 观察，避免把 DB 故障误报成无数据
          const cityRes = await session
            .from("cities")
            .select("timezone")
            .eq("id", parsed.data.cityId)
            .eq("is_active", true)
            .maybeSingle()
          if (cityRes.error) {
            return JSON.stringify({ error: "source data query failed" })
          }
          const city = cityRes.data as { timezone: string } | null
          if (!city) return JSON.stringify({ status: "no-data" })
          const day = toLocalDateKey(new Date().toISOString(), city.timezone)
          const { data, error } = await session
            .from("weather_daily")
            .select(
              "source, day, high_temp, low_temp, precipitation, condition_label, condition_category"
            )
            .eq("city_id", parsed.data.cityId)
            .eq("day", day)
          if (error) return JSON.stringify({ error: "source data query failed" })
          const rows = (data ?? []) as {
            source: string
            high_temp: number
            low_temp: number
            precipitation: number
            condition_label: string | null
            condition_category: string | null
          }[]
          if (rows.length === 0) return JSON.stringify({ status: "no-data" })
          // 逐源映射：label 用平台显示名，condition_label 保留源自身文案，condition_category 供模型归一口径
          return JSON.stringify({
            status: "success",
            cityId: parsed.data.cityId,
            day,
            sources: rows.map((r) => ({
              source: r.source,
              label: SOURCE_LABELS[r.source] ?? r.source,
              high: r.high_temp,
              low: r.low_temp,
              precipitationMm: r.precipitation,
              conditionLabel: r.condition_label ?? null,
              conditionCategory: r.condition_category ?? null,
            })),
          })
        } catch {
          return JSON.stringify({ error: "source data query failed" })
        }
      },
    },
    {
      name: "query_weather_history",
      description: desc.queryWeatherHistory,
      parameters: {
        type: "object",
        properties: {
          cityId: { type: "string", format: "uuid" },
          days: { type: "integer", minimum: 1, maximum: 7 },
        },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const parsed = historyParams.safeParse(args)
        if (!parsed.success) {
          return JSON.stringify({
            error: "invalid arguments: cityId must be a uuid and days must be 1..7",
          })
        }
        try {
          // 定位城市取时区算历史窗口：weather_daily 按 城×源×城市本地日 存，
          // 平台保留近 7 天（pipeline 每日清理更早快照），days 越界已在 schema 拒绝。
          // 城市查询本身报错（非「不存在」）→ error 观察，避免把 DB 故障误报成无数据
          const cityRes = await session
            .from("cities")
            .select("timezone")
            .eq("id", parsed.data.cityId)
            .eq("is_active", true)
            .maybeSingle()
          if (cityRes.error) {
            return JSON.stringify({ error: "history data query failed" })
          }
          const city = cityRes.data as { timezone: string } | null
          if (!city) return JSON.stringify({ status: "no-data" })
          const days = parsed.data.days ?? 7
          const to = toLocalDateKey(new Date().toISOString(), city.timezone)
          const from = daysAgoLocalDateKey(city.timezone, days - 1)
          const { data, error } = await session
            .from("weather_daily")
            .select(
              "source, day, high_temp, low_temp, precipitation, condition_label, condition_category"
            )
            .eq("city_id", parsed.data.cityId)
            .gte("day", from)
            .lte("day", to)
            .order("day", { ascending: true })
            .order("source")
          if (error) return JSON.stringify({ error: "history data query failed" })
          const rows = (data ?? []) as {
            source: string
            day: string
            high_temp: number
            low_temp: number
            precipitation: number
            condition_label: string | null
            condition_category: string | null
          }[]
          if (rows.length === 0) return JSON.stringify({ status: "no-data" })
          // 按城市本地日分组、日内按源排序；label 用平台显示名，condition 保留源文案+归一分类，
          // 供模型按天组织叙述（改口径/编造都会被分组后的真实值对不上）
          const byDay = new Map<string, Record<string, unknown>[]>()
          for (const r of rows) {
            const list = byDay.get(r.day) ?? []
            list.push({
              source: r.source,
              label: SOURCE_LABELS[r.source] ?? r.source,
              high: r.high_temp,
              low: r.low_temp,
              precipitationMm: r.precipitation,
              conditionLabel: r.condition_label ?? null,
              conditionCategory: r.condition_category ?? null,
            })
            byDay.set(r.day, list)
          }
          return JSON.stringify({
            status: "success",
            cityId: parsed.data.cityId,
            from,
            to,
            days: Array.from(byDay, ([day, sources]) => ({ day, sources })),
          })
        } catch {
          return JSON.stringify({ error: "history data query failed" })
        }
      },
    },
    {
      name: "query_forecast",
      description: desc.queryForecast,
      parameters: {
        type: "object",
        properties: { cityId: { type: "string", format: "uuid" } },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const parsed = cityIdParam.safeParse(args)
        if (!parsed.success) {
          return JSON.stringify({
            error: "invalid arguments: cityId must be a uuid",
          })
        }
        // 只读入口：按城市时区算今日再读预测行，无行/城不存在均返回 null
        const row = await readForecastForCity(session, parsed.data.cityId, locale)
        if (!row) return JSON.stringify({ status: "no-data" })
        // pending 是生成中的中间态（另一请求在认领），主 Agent 按状态如实告知
        if (row.status !== "success") {
          return JSON.stringify({
            status: row.status === "failed" ? "error" : "pending",
            code: row.status === "failed" ? (row.error_code ?? "generic") : "generating",
          })
        }
        return JSON.stringify(forecastRowToObservation(row))
      },
    },
    {
      name: "generate_forecast",
      description: desc.generateForecast,
      parameters: {
        type: "object",
        properties: { cityId: { type: "string", format: "uuid" } },
        required: ["cityId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const parsed = cityIdParam.safeParse(args)
        if (!parsed.success) {
          return JSON.stringify({
            error: "invalid arguments: cityId must be a uuid",
          })
        }
        // 认领行需要 created_by；无邮箱（异常态）拒绝委托，避免落库缺归属
        if (!email) {
          return JSON.stringify({ status: "error", code: "unauthorized" })
        }
        try {
          // 消费子 Agent 全流程事件：duplicate（已有行）/done（新生成）都给出成功观察；
          // error 透传子 Agent 错误码。中间的 status/delta/thought/tool 是子 Agent 内部
          // 过程，对主 Agent 无意义，静默跳过
          for await (const ev of runForecastAgentStream(session, service, {
            cityId: parsed.data.cityId,
            email,
            locale,
            model,
            signal,
          })) {
            if (ev.type === "done" || ev.type === "duplicate") {
              return JSON.stringify(forecastRowToObservation(ev.row))
            }
            if (ev.type === "error") {
              return JSON.stringify({ status: "error", code: ev.code })
            }
          }
          return JSON.stringify({ status: "error", code: "generic" })
        } catch {
          return JSON.stringify({ status: "error", code: "generic" })
        }
      },
    },
  ]
}
