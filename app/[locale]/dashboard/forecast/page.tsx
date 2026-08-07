import { getTranslations } from "next-intl/server"

import { ForecastView } from "@/components/dashboard/forecast/forecast-view"
import { createClient } from "@/supabase/server"
import { isAdminEmail } from "@/lib/weather/admin"
import { resolveCityParam } from "@/lib/weather/resolve-city"
import type { CityRow, CurrentRow, RunRow } from "@/lib/weather/view-types"

// 预报页：解析 ?city= 参数为唯一城市，只取该城三源当前天气与最近一次运行，交给客户端组件展示；
// 城市列表页「显示预报」按钮跳转时携带 ?city=<name_en>，参数缺失/无效由 resolveCityParam 补齐重定向
export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string }>
}) {
  const t = await getTranslations("dashboard.forecast")
  const supabase = await createClient()
  const { city: rawCity } = await searchParams

  const [citiesRes, runRes, userRes] = await Promise.all([
    supabase.from("cities").select("*").eq("is_active", true).order("name_en"),
    supabase
      .from("weather_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(1),
    supabase.auth.getUser(),
  ])

  const cities = (citiesRes.data ?? []) as CityRow[]
  // 先解析出唯一城市（内部可能重定向补齐参数），再按 city_id 取单城当前天气
  const selected = await resolveCityParam(cities, rawCity, "/dashboard/forecast")
  const currentRes = selected
    ? await supabase
        .from("weather_current")
        .select("*")
        .eq("city_id", selected.id)
        .order("updated_at", { ascending: false })
    : null

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <ForecastView
        cities={cities}
        selectedCityId={selected?.id ?? ""}
        currents={(currentRes?.data ?? []) as CurrentRow[]}
        latestRun={(runRes.data?.[0] ?? null) as RunRow | null}
        isAdmin={isAdminEmail(userRes.data.user?.email)}
      />
    </div>
  )
}
