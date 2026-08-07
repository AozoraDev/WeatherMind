"use client"

import { RefreshCw } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useMutation } from "@tanstack/react-query"

import { ButtonBlue } from "@/components/ui-preset/button"
import {
  WeatherCityCard,
  WEATHER_SOURCES,
} from "@/components/ui-preset/weather-city-card"
import { useToast } from "@/components/ui-preset/toast"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useRouter } from "@/i18n/navigation"
import { refreshWeatherAction } from "@/lib/weather/actions"
import { WeatherError } from "@/lib/weather/errors"
import type { WeatherSource } from "@/lib/schemas/weather"
import type { CityRow, CurrentRow, RunRow } from "@/lib/weather/view-types"

// 预报页视图：服务端已按 ?city= 解析出唯一城市，这里展示该城三源当前天气卡片 + 手动刷新（仅管理员）+ 最近运行状态；
// 下拉切换城市即导航到新 ?city= 的预报页，由服务端重取该城数据
export function ForecastView({
  cities,
  selectedCityId,
  currents,
  latestRun,
  isAdmin,
}: {
  cities: CityRow[]
  selectedCityId: string
  currents: CurrentRow[]
  latestRun: RunRow | null
  isAdmin: boolean
}) {
  const t = useTranslations("dashboard.forecast")
  const locale = useLocale()
  const router = useRouter()
  const toast = useToast()

  // 切换城市 = 导航到带新 ?city= 的预报页，服务端按参数重取单城数据
  const handleCityChange = (cityId: string) => {
    const city = cities.find((c) => c.id === cityId)
    if (city) {
      router.push(
        { pathname: "/dashboard/forecast", query: { city: city.name_en } },
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
      // 重拉服务端数据，刷新卡片与最近运行
      router.refresh()
    },
    onError: (e) => {
      toast.error(
        e instanceof WeatherError ? t(`errors.${e.code}`) : t("errors.generic")
      )
    },
  })

  // 按 城×源 取最近一条当前天气（表中每 城×源 只有一行，这里防御性去重）
  const latestByCell = new Map<string, CurrentRow>()
  for (const row of currents) {
    const key = `${row.city_id}:${row.source}`
    if (!latestByCell.has(key)) latestByCell.set(key, row)
  }

  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Tokyo",
    }).format(new Date(iso))

  // 各平台名文案一次性注入卡片预设
  const sourceLabels = Object.fromEntries(
    WEATHER_SOURCES.map((s) => [s, t(`sources.${s}`)])
  ) as Record<WeatherSource, string>

  // 城市 id → 展示名映射，供 SelectValue 渲染选中项标签
  const cityLabels = Object.fromEntries(
    cities.map((city) => [city.id, `${city.name_ja} · ${city.name_en}`])
  )

  // 选中城市的各源最新数据；缺源时卡片内部会逐源兜底显示「暂无数据」
  const selectedCity = cities.find((c) => c.id === selectedCityId)
  const cells = selectedCity
    ? (Object.fromEntries(
        WEATHER_SOURCES.map((s) => [
          s,
          latestByCell.get(`${selectedCity.id}:${s}`) ?? null,
        ])
      ) as Record<WeatherSource, CurrentRow | null>)
    : null

  return (
    <div className="flex flex-col gap-6">
      {cities.length === 0 || latestByCell.size === 0 ? (
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

            <div className="ml-auto flex items-center gap-4">
              {latestRun ? (
                <p className="text-sm text-muted-foreground">
                  {t("lastUpdated", { time: formatTime(latestRun.started_at) })}
                  <span className="ml-2 text-foreground">
                    {t(`status.${latestRun.status}`)}
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              )}
              {isAdmin && (
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
              )}
            </div>
          </div>

          {selectedCity && cells && (
            <div className="max-w-xl">
              <WeatherCityCard
                key={selectedCity.id}
                city={selectedCity}
                cells={cells}
                sourceLabels={sourceLabels}
                humidityLabel={t("fields.humidity")}
                windLabel={t("fields.wind")}
                noDataLabel={t("noData")}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
