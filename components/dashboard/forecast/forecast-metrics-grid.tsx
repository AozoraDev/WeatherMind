"use client"

import type { LucideIcon } from "lucide-react"
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Cloudy,
  Droplets,
  Gauge,
  ShieldAlert,
  ShieldCheck,
  Sun,
  ThermometerSnowflake,
  ThermometerSun,
  Umbrella,
  Wind,
} from "lucide-react"
import { useTranslations } from "next-intl"

import type { ForecastDbRow, RiskFlag } from "@/lib/schemas/forecast-agent"
import { conditionCategorySchema } from "@/lib/schemas/weather"
import { cn, formatWeatherNumber } from "@/lib/utils"

// ForecastAgent 结果卡里的指标图标卡网格：把「预测高温/低温/降水概率/等级/状况/风力/湿度/
// 可信度/风险」用一张张带 icon 的小卡片逐项展示。数值全部来自 DB 权威结构化字段
//（确定性引擎 settle 时写入），不解析 AI 正文，故新 Markdown 行与旧结构化行通用；
// null 一律显 —。纯展示组件，label/hint/risk 文案均由 i18n 提供。

// 每张卡的渲染配置：icon 色块（浅色模式） + label + value + 副文本
type MetricCard = {
  key: string
  icon: LucideIcon
  chip: string // icon 色块配色（bg + text）
  label: string
  value: string
  sub: string // 副文本：高温/低温显示区间，其余显示指标口径说明
}

// 合法归一分类集合：condition 值走 i18n 文案前先校验，防库里非法值落到缺失键
const VALID_CONDITIONS = new Set<string>(conditionCategorySchema.options)

// condition → 图标：与「天气状况」语义对应，非法值兜底 Cloud
const CONDITION_ICONS: Record<string, LucideIcon> = {
  clear: Sun,
  partlyCloudy: CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
  other: Cloudy,
}

// 区间格式化：null 兜底 —，复用与旧演算表格一致的口径
function intervalLabel(interval: [number, number] | null): string {
  if (!interval) return "—"
  return `${formatWeatherNumber(interval[0])} ~ ${formatWeatherNumber(interval[1])} °C`
}

// 由 DB 行构建 9 张指标卡（顺序与展示样例一致）；风险文本按 type · level 连接
function buildCards(
  row: ForecastDbRow,
  t: ReturnType<typeof useTranslations<"dashboard.forecast.forecastAgent">>
): MetricCard[] {
  const m = (key: string) => ({
    label: t(`metrics.${key}.label`),
    hint: t(`metrics.${key}.hint`),
  })

  // 条件分类：仅合法值才走 i18n 文案，否则原样展示（兜底缺失键）
  const condition =
    row.condition && VALID_CONDITIONS.has(row.condition) ? row.condition : null

  const hasRisk = (row.risk_flags ?? []).length > 0
  const riskText = hasRisk
    ? (row.risk_flags ?? [])
        .map(
          (f) =>
            `${t(`riskType.${(f as RiskFlag).type}`)} · ${t(
              `riskLevel.${(f as RiskFlag).level}`
            )}`
        )
        .join(" · ")
    : t("riskNone")

  return [
    {
      key: "high",
      icon: ThermometerSun,
      chip: "bg-amber-100 text-amber-600",
      label: m("high").label,
      value:
        row.predicted_high == null
          ? "—"
          : `${formatWeatherNumber(row.predicted_high)} °C`,
      sub: intervalLabel(row.high_interval),
    },
    {
      key: "low",
      icon: ThermometerSnowflake,
      chip: "bg-sky-100 text-sky-600",
      label: m("low").label,
      value:
        row.predicted_low == null
          ? "—"
          : `${formatWeatherNumber(row.predicted_low)} °C`,
      sub: intervalLabel(row.low_interval),
    },
    {
      key: "poP",
      icon: CloudRain,
      chip: "bg-blue-100 text-blue-600",
      label: m("poP").label,
      value:
        row.precipitation_probability == null
          ? "—"
          : `${Math.round(row.precipitation_probability)}%`,
      sub: m("poP").hint,
    },
    {
      key: "precipLevel",
      icon: Umbrella,
      chip: "bg-cyan-100 text-cyan-600",
      label: m("precipLevel").label,
      value: row.precip_level ? t(`precipLevel.${row.precip_level}`) : "—",
      sub: m("precipLevel").hint,
    },
    {
      key: "condition",
      icon: condition ? (CONDITION_ICONS[condition] ?? Cloud) : Cloud,
      chip: "bg-indigo-100 text-indigo-600",
      label: m("condition").label,
      value: condition ? t(`condition.${condition}`) : (row.condition ?? "—"),
      sub: m("condition").hint,
    },
    {
      key: "wind",
      icon: Wind,
      chip: "bg-teal-100 text-teal-600",
      label: m("wind").label,
      value:
        row.wind_beaufort == null
          ? "—"
          : `${row.wind_beaufort} ${t("units.wind")}`,
      sub: m("wind").hint,
    },
    {
      key: "humidity",
      icon: Droplets,
      chip: "bg-emerald-100 text-emerald-600",
      label: m("humidity").label,
      value:
        row.humidity == null ? "—" : `${formatWeatherNumber(row.humidity)}%`,
      sub: m("humidity").hint,
    },
    {
      key: "confidence",
      icon: Gauge,
      chip: "bg-violet-100 text-violet-600",
      label: m("confidence").label,
      value: row.confidence ? t(`confidence.${row.confidence}`) : "—",
      sub: m("confidence").hint,
    },
    {
      key: "risk",
      icon: hasRisk ? ShieldAlert : ShieldCheck,
      chip: hasRisk ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-500",
      label: m("risk").label,
      value: riskText,
      sub: m("risk").hint,
    },
  ]
}

export function ForecastMetricsGrid({ row }: { row: ForecastDbRow }) {
  const t = useTranslations("dashboard.forecast.forecastAgent")
  const cards = buildCards(row, t)

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
      {cards.map((card) => (
        <li
          key={card.key}
          className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/80 p-3.5 shadow-sm"
        >
          {/* 图标徽章固定左侧，与右侧文字列分栏，避免上下堆叠 */}
          <span
            aria-hidden="true"
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              card.chip
            )}
          >
            <card.icon className="size-4.5" />
          </span>
          {/* 文字列：label/数值/说明纵排；label 与说明 truncate 防窄列断行，risk 长值自然换行 */}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate text-xs font-medium text-muted-foreground">
              {card.label}
            </p>
            <p className="text-base font-semibold leading-snug tabular-nums">
              {card.value}
            </p>
            <p className="truncate text-xs text-muted-foreground/70">
              {card.sub}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
