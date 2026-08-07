import { getTranslations } from "next-intl/server"

import { ForecastView } from "@/components/dashboard/forecast/forecast-view"
import { createClient } from "@/supabase/server"
import { isAdminEmail } from "@/lib/weather/admin"
import type { CityRow, CurrentRow, RunRow } from "@/lib/weather/view-types"

// 预报页：读启用的城市、各源当前天气与最近一次运行，交给客户端组件按城市切换展示；
// 支持 ?city=<name_en> 查询参数预选城市（城市列表页「显示预报」按钮跳转时携带）
export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string }>
}) {
  const t = await getTranslations("dashboard.forecast")
  const supabase = await createClient()
  const { city: initialCityName } = await searchParams

  const [citiesRes, currentRes, runRes, userRes] = await Promise.all([
    supabase.from("cities").select("*").eq("is_active", true).order("name_en"),
    supabase
      .from("weather_current")
      .select("*")
      .order("updated_at", { ascending: false }),
    supabase
      .from("weather_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(1),
    supabase.auth.getUser(),
  ])

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <ForecastView
        cities={(citiesRes.data ?? []) as CityRow[]}
        currents={(currentRes.data ?? []) as CurrentRow[]}
        latestRun={(runRes.data?.[0] ?? null) as RunRow | null}
        isAdmin={isAdminEmail(userRes.data.user?.email)}
        initialCityName={initialCityName}
      />
    </div>
  )
}
