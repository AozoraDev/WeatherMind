import { getTranslations } from "next-intl/server"

import { HistoryView } from "@/components/dashboard/history/history-view"
import { createClient } from "@/supabase/server"
import { isAdminEmail } from "@/lib/weather/admin"
import { daysAgoLocalDateKey } from "@/lib/weather/daily"
import { resolveCityParam } from "@/lib/weather/resolve-city"
import type { CityRow, DailyRow } from "@/lib/weather/view-types"

// 历史天气页：解析 ?city= 参数为唯一城市，只取该城近 7 天每日快照，交给客户端组件展示；
// 城市列表页「显示历史」按钮跳转时携带 ?city=<name_en>，参数缺失/无效由 resolveCityParam 补齐重定向
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string }>
}) {
  const t = await getTranslations("dashboard.history")
  const supabase = await createClient()
  const { city: rawCity } = await searchParams

  const [citiesRes, userRes] = await Promise.all([
    supabase.from("cities").select("*").eq("is_active", true).order("name_en"),
    supabase.auth.getUser(),
  ])

  const cities = (citiesRes.data ?? []) as CityRow[]
  // 先解析出唯一城市（内部可能重定向补齐参数），截止日按该城自身时区计算，避免写死参考时区
  const selected = await resolveCityParam(cities, rawCity, "/dashboard/history")
  const cutoff = daysAgoLocalDateKey(selected?.timezone ?? "Asia/Tokyo", 6)
  const dailyRes = selected
    ? await supabase
        .from("weather_daily")
        .select("*")
        .eq("city_id", selected.id)
        .gte("day", cutoff)
        .order("day", { ascending: true })
        .order("source")
    : null

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <HistoryView
        cities={cities}
        selectedCityId={selected?.id ?? ""}
        rows={(dailyRes?.data ?? []) as DailyRow[]}
        isAdmin={isAdminEmail(userRes.data.user?.email)}
      />
    </div>
  )
}
