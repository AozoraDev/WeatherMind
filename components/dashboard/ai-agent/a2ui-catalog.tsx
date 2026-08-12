"use client"

import { basicCatalog, createComponentImplementation } from "@a2ui/react/v0_9"
import { Catalog } from "@a2ui/web_core/v0_9"
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
  type LucideIcon,
} from "lucide-react"

import { metricTileSchema } from "@/lib/schemas/a2ui-catalog"
import { cn } from "@/lib/utils"

// 自定义 a2ui catalog：在 basicCatalog 基础上新增 MetricTile 组件（预报指标磁贴）。
// 背景：basicCatalog 的 Icon 只支持一组固定通用图标（无天气图标）或 fill 型 SVG path，既渲染不了
// lucide 描边图标，也无法给每张磁贴配色；故新增自定义组件，由客户端把服务端模板下发的「icon/chip
// 语义键」直接映射到 lucide 图标 + 彩色图标块（与预报页 ForecastMetricsGrid 口径一致）。
// 值/说明走 path 绑定到 data model（动态字符串），标签为静态文案。

// 图标语义键 → lucide 组件；未知键兜底 Cloud
const ICONS: Record<string, LucideIcon> = {
  thermHigh: ThermometerSun,
  thermLow: ThermometerSnowflake,
  rain: CloudRain,
  umbrella: Umbrella,
  sun: Sun,
  cloudsun: CloudSun,
  cloud: Cloud,
  fog: CloudFog,
  snow: CloudSnow,
  storm: CloudLightning,
  cloudy: Cloudy,
  wind: Wind,
  droplets: Droplets,
  gauge: Gauge,
  shieldAlert: ShieldAlert,
  shieldCheck: ShieldCheck,
}

// 配色语义键 → 图标块颜色（bg + text）；未知键兜底 slate
const CHIPS: Record<string, string> = {
  amber: "bg-amber-100 text-amber-600",
  sky: "bg-sky-100 text-sky-600",
  blue: "bg-blue-100 text-blue-600",
  cyan: "bg-cyan-100 text-cyan-600",
  indigo: "bg-indigo-100 text-indigo-600",
  teal: "bg-teal-100 text-teal-600",
  emerald: "bg-emerald-100 text-emerald-600",
  violet: "bg-violet-100 text-violet-600",
  rose: "bg-rose-100 text-rose-600",
  slate: "bg-slate-100 text-slate-500",
}

// 磁贴：左侧彩色图标块 + 右侧标签/数值（/说明）列。flex-1 让同行的两张磁贴平分宽度。
// 服务端模板发出的是 icon/chip 语义键，这里做图标与配色的最后映射。
// createComponentImplementation 的 api 参数是 ComponentApi 形状（name + schema），
// name 即消息里 component 字段的值，schema 即服务端模板必须对齐的 MetricTile 严格校验。
const MetricTile = createComponentImplementation(
  { name: "MetricTile", schema: metricTileSchema },
  ({ props }) => {
    const Icon = ICONS[props.icon] ?? Cloud
    const chip = CHIPS[props.chip] ?? CHIPS.slate
    return (
      <div className="flex flex-1 items-start gap-3 rounded-xl border border-border/60 bg-card/80 p-3.5 shadow-sm">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            chip
          )}
        >
          <Icon className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-xs font-medium text-muted-foreground">
            {props.label}
          </p>
          <p className="text-base leading-snug font-semibold tabular-nums">
            {props.value}
          </p>
          {props.sub && (
            <p className="truncate text-xs text-muted-foreground/70">
              {props.sub}
            </p>
          )}
        </div>
      </div>
    )
  }
)

// 复用 basicCatalog 的全部组件 + 追加 MetricTile；catalogId 与 basicCatalog 相同，服务端模板
// 与 DB 里既有卡片（createSurface 均指向 BASIC_CATALOG_ID）都能命中此 catalog
export const aiAgentCatalog = new Catalog(
  basicCatalog.id,
  [...basicCatalog.components.values(), MetricTile],
  [...basicCatalog.functions.values()]
)
