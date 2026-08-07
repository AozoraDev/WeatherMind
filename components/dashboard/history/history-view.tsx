"use client"

import { History, RefreshCw } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useMutation } from "@tanstack/react-query"

import { ButtonBlue } from "@/components/ui-preset/button"
import { HistoryCharts } from "@/components/dashboard/history/history-charts"
import { DataTable, DataTableRow } from "@/components/ui-preset/data-table"
import { SOURCE_COLORS } from "@/components/ui-preset/weather-city-card"
import { TableCell } from "@/components/ui/table"
import { useToast } from "@/components/ui-preset/toast"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useRouter } from "@/i18n/navigation"
import { cn, formatWeatherNumber } from "@/lib/utils"
import {
  backfillWeatherAction,
  refreshWeatherAction,
} from "@/lib/weather/actions"
import { WeatherError } from "@/lib/weather/errors"
import {
  conditionCategorySchema,
  type ConditionCategory,
} from "@/lib/schemas/weather"
import type { CityRow, DailyRow } from "@/lib/weather/view-types"

// 合法归一分类集合，用于把 DB 文本安全映射到 i18n 文案（非法值回退源文案）
const VALID_CATEGORIES = new Set<string>(conditionCategorySchema.options)

// 历史天气视图：服务端已按 ?city= 解析出唯一城市并只取该城近 7 天快照，这里做表格 + 图表展示；
// 下拉切换城市即导航到新 ?city= 的历史页，由服务端重取该城数据
export function HistoryView({
  cities,
  selectedCityId,
  rows,
  isAdmin,
}: {
  cities: CityRow[]
  selectedCityId: string
  rows: DailyRow[]
  isAdmin: boolean
}) {
  const t = useTranslations("dashboard.history")
  const locale = useLocale()
  const router = useRouter()
  const toast = useToast()

  // 切换城市 = 导航到带新 ?city= 的历史页，服务端按参数重取单城数据
  const handleCityChange = (cityId: string) => {
    const city = cities.find((c) => c.id === cityId)
    if (city) {
      router.push(
        { pathname: "/dashboard/history", query: { city: city.name_en } },
        { scroll: false }
      )
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await refreshWeatherAction()
      if (!res.ok) throw new WeatherError(res.error)
      return res.summary
    },
    onSuccess: () => {
      toast.success(t("refreshSuccess"))
      // 重拉服务端数据，让今日快照立即反映最新值
      router.refresh()
    },
    onError: (e) => {
      toast.error(
        e instanceof WeatherError ? t(`errors.${e.code}`) : t("errors.generic")
      )
    },
  })

  // 一键回填近 7 天（含今天）：独立于常规刷新的历史补采，成功同样重拉服务端数据
  const backfill = useMutation({
    mutationFn: async () => {
      const res = await backfillWeatherAction(7)
      if (!res.ok) throw new WeatherError(res.error)
      return res.summary
    },
    onSuccess: () => {
      toast.success(t("backfillSuccess"))
      router.refresh()
    },
    onError: (e) => {
      toast.error(
        e instanceof WeatherError ? t(`errors.${e.code}`) : t("errors.generic")
      )
    },
  })

  // 城市 id → 展示名的映射，供 SelectValue 渲染选中项标签
  const cityLabels = Object.fromEntries(
    cities.map((city) => [city.id, `${city.name_ja} · ${city.name_en}`])
  )

  // 日期键（YYYY-MM-DD）→ 本地化展示；用本地零点构造避免 new Date("YYYY-MM-DD") 按 UTC 偏移一天
  const formatDay = (day: string) => {
    const [y, m, d] = day.split("-").map(Number)
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      new Date(y, m - 1, d)
    )
  }

  // 天气列：合法归一分类走 i18n 文案，否则回退源文案
  const conditionOf = (row: DailyRow) => {
    if (
      row.condition_category &&
      VALID_CATEGORIES.has(row.condition_category)
    ) {
      return t(`categories.${row.condition_category as ConditionCategory}`)
    }
    return row.condition_label ?? "—"
  }

  return (
    <div className="flex flex-col gap-6">
      {cities.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-muted-foreground">{t("empty")}</p>
          {isAdmin && (
            <ButtonBlue
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? t("refreshing") : t("refresh")}
            </ButtonBlue>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t("selectCity")}
              </span>
              <Select
                value={selectedCityId}
                onValueChange={(v) => v && handleCityChange(String(v))}
                items={cityLabels}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cities.map((city) => (
                    <SelectItem key={city.id} value={city.id}>
                      {city.name_ja} · {city.name_en}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isAdmin && (
              <div className="ml-auto flex items-center gap-2">
                <ButtonBlue
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate()}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={mutation.isPending ? "animate-spin" : ""}
                  />
                  {mutation.isPending ? t("refreshing") : t("refresh")}
                </ButtonBlue>
                <ButtonBlue
                  size="sm"
                  disabled={backfill.isPending}
                  onClick={() => backfill.mutate()}
                >
                  <History
                    aria-hidden="true"
                    className={backfill.isPending ? "animate-spin" : ""}
                  />
                  {backfill.isPending ? t("backfilling") : t("backfill")}
                </ButtonBlue>
              </div>
            )}
          </div>

          {/* 图表区：温度趋势折线图 + 降水/天气概览卡，置于表格上方；无数据时随表格一并空置 */}
          {rows.length > 0 && <HistoryCharts rows={rows} />}

          <DataTable
            headers={[
              { label: t("columns.date") },
              { label: t("columns.platform") },
              { label: t("columns.high") },
              { label: t("columns.low") },
              { label: t("columns.precipitation") },
              { label: t("columns.condition") },
            ]}
            empty={rows.length === 0 ? t("noData") : null}
          >
            {rows.map((row) => (
              <DataTableRow key={row.id}>
                <TableCell className="font-medium">
                  {formatDay(row.day)}
                </TableCell>
                <TableCell
                  className={cn("font-medium", SOURCE_COLORS[row.source])}
                >
                  {t(`sources.${row.source}`)}
                </TableCell>
                <TableCell>{formatWeatherNumber(row.high_temp)}°C</TableCell>
                <TableCell>{formatWeatherNumber(row.low_temp)}°C</TableCell>
                <TableCell>
                  {formatWeatherNumber(row.precipitation)} mm
                </TableCell>
                <TableCell>{conditionOf(row)}</TableCell>
              </DataTableRow>
            ))}
          </DataTable>
        </>
      )}
    </div>
  )
}
