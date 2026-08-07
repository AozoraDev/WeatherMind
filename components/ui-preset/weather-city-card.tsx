import type { WeatherSource } from "@/lib/schemas/weather"
import type { CityRow, CurrentRow } from "@/lib/weather/view-types"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn, formatWeatherNumber } from "@/lib/utils"

// 三个数据源在卡片内各自的平台名配色（浅色模式下可读），与历史表格平台列保持同套配色
export const SOURCE_COLORS: Record<WeatherSource, string> = {
  "open-meteo": "text-emerald-600",
  openweather: "text-sky-600",
  weatherapi: "text-amber-600",
}

// 卡片内三源的固定排列顺序
export const WEATHER_SOURCES: WeatherSource[] = [
  "open-meteo",
  "openweather",
  "weatherapi",
]

type WeatherCityCardProps = {
  city: CityRow
  // 该城市各源的最新当前天气，缺源时为 null
  cells: Record<WeatherSource, CurrentRow | null>
  // i18n 文案由调用方注入，保持预设不感知 next-intl
  sourceLabels: Record<WeatherSource, string>
  humidityLabel: string
  windLabel: string
  noDataLabel: string
}

// 预报城市卡片预设：城市名 + 三源当前天气（平台名各自着色、带同色圆点），
// 顶部蓝紫渐变饰条 + 表头淡色渐变提升辨识度，与 DataTable 蓝色签名呼应
export function WeatherCityCard({
  city,
  cells,
  sourceLabels,
  humidityLabel,
  windLabel,
  noDataLabel,
}: WeatherCityCardProps) {
  return (
    <Card className="overflow-hidden bg-linear-to-r from-sky-100/70 via-blue-50/40 to-indigo-100/70 shadow-sm">
      {/* 顶部渐变饰条：负边距抵消 Card 自身内边距，使其贴住卡片上缘 */}
      <div
        aria-hidden="true"
        className="-mx-(--card-spacing) -mt-(--card-spacing) h-1 bg-linear-to-r from-sky-400 to-blue-500"
      />
      <CardHeader className="border-b border-sky-200/60">
        <CardTitle className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full bg-blue-500"
          />
          {city.name_ja} · {city.name_en}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border/60">
        {WEATHER_SOURCES.map((source) => {
          const cell = cells[source]
          // 平台名：彩色文字 + 同色圆点（圆点用 bg-current 继承文字色，省一份配色）
          const name = (
            <p
              className={cn(
                "flex items-center gap-1.5 text-sm font-medium",
                SOURCE_COLORS[source]
              )}
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full bg-current"
              />
              {sourceLabels[source]}
            </p>
          )
          return (
            <div
              key={source}
              className="flex items-center justify-between gap-3 py-3"
            >
              {cell ? (
                <>
                  <div className="min-w-0">
                    {name}
                    <p className="truncate text-xs text-muted-foreground">
                      {cell.condition_label ?? "—"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-lg font-semibold tabular-nums">
                      {formatWeatherNumber(cell.temperature)}°C
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {humidityLabel}{" "}
                      {cell.humidity == null
                        ? "—"
                        : formatWeatherNumber(cell.humidity)}
                      % · {windLabel} {formatWeatherNumber(cell.wind_speed)} m/s
                    </p>
                  </div>
                </>
              ) : (
                <>
                  {name}
                  <p className="text-xs text-muted-foreground">{noDataLabel}</p>
                </>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
