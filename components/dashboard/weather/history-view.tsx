"use client"

import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useMutation } from "@tanstack/react-query"

import { ButtonBlue } from "@/components/ui-preset/button"
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
import { cn } from "@/lib/utils"
import { refreshWeatherAction } from "@/lib/weather/actions"
import { WeatherError } from "@/lib/weather/errors"
import {
  conditionCategorySchema,
  type ConditionCategory,
} from "@/lib/schemas/weather"
import type { CityRow, DailyRow } from "@/lib/weather/view-types"

// 合法归一分类集合，用于把 DB 文本安全映射到 i18n 文案（非法值回退源文案）
const VALID_CATEGORIES = new Set<string>(conditionCategorySchema.options)

// 历史天气视图：城市下拉 + 近 7 天每日快照表格（平台列区分三个数据源）+ 手动刷新按钮（仅管理员）
export function HistoryView({
  cities,
  rows,
  isAdmin,
  // 从 URL ?city= 带入的预选城市 name_en；无效值会被下方初始化逻辑兜底回退
  initialCityName,
}: {
  cities: CityRow[]
  rows: DailyRow[]
  isAdmin: boolean
  initialCityName?: string
}) {
  const t = useTranslations("dashboard.history")
  const locale = useLocale()
  const router = useRouter()
  const toast = useToast()

  // 默认选中 URL 带入的 name_en（需在启用城市中），否则回退东京，再退到第一个城市
  const [selectedCityId, setSelectedCityId] = useState(
    () =>
      cities.find(
        (c) => c.name_en.toLowerCase() === (initialCityName ?? "").toLowerCase()
      )?.id ??
      cities.find((c) => c.name_en.toLowerCase() === "tokyo")?.id ??
      cities[0]?.id ??
      ""
  )

  // 选中城市同步到 URL ?city=<name_en>，保证与城市列表页「显示历史」入口的地址栏形态一致；
  // 侧边栏直接进历史页时初始会补上默认城市参数，下拉切换后地址也跟随更新
  useEffect(() => {
    if (!selectedCityId) return
    const selectedName = cities.find((c) => c.id === selectedCityId)?.name_en
    if (!selectedName) return
    // 初始值已与 URL 一致（城市列表页跳转场景）时跳过，避免无谓重复导航
    if (initialCityName?.toLowerCase() === selectedName.toLowerCase()) return
    router.replace(
      { pathname: "/dashboard/history", query: { city: selectedName } },
      { scroll: false }
    )
  }, [selectedCityId, initialCityName, cities, router])

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

  // 只按城市过滤：同一日期三个平台的行并列展示，靠平台列区分
  const filtered = rows.filter((r) => r.city_id === selectedCityId)

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
                onValueChange={(v) => v && setSelectedCityId(String(v))}
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
              <div className="ml-auto">
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
              </div>
            )}
          </div>

          <DataTable
            headers={[
              { label: t("columns.date") },
              { label: t("columns.platform") },
              { label: t("columns.high") },
              { label: t("columns.low") },
              { label: t("columns.precipitation") },
              { label: t("columns.condition") },
            ]}
            empty={filtered.length === 0 ? t("noData") : null}
          >
            {filtered.map((row) => (
              <DataTableRow key={row.id}>
                <TableCell className="font-medium">
                  {formatDay(row.day)}
                </TableCell>
                <TableCell
                  className={cn("font-medium", SOURCE_COLORS[row.source])}
                >
                  {t(`sources.${row.source}`)}
                </TableCell>
                <TableCell>{row.high_temp.toFixed(1)}°C</TableCell>
                <TableCell>{row.low_temp.toFixed(1)}°C</TableCell>
                <TableCell>{row.precipitation.toFixed(1)} mm</TableCell>
                <TableCell>{conditionOf(row)}</TableCell>
              </DataTableRow>
            ))}
          </DataTable>
        </>
      )}
    </div>
  )
}
