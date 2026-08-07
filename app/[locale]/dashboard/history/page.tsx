import { getTranslations } from "next-intl/server"

import { HistoryView } from "@/components/dashboard/history/history-view"
import { createClient } from "@/supabase/server"
import { isAdminEmail } from "@/lib/weather/admin"
import { daysAgoLocalDateKey } from "@/lib/weather/daily"
import type { CityRow, DailyRow } from "@/lib/weather/view-types"

// 历史天气页：读启用的城市与近 7 天每日快照，交给客户端组件按城市/源切换展示；
// 支持 ?city=<name_en> 查询参数预选城市（城市列表页「显示历史」按钮跳转时携带）
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string }>
}) {
  const t = await getTranslations("dashboard.history")
  const supabase = await createClient()
  const { city: initialCityName } = await searchParams

  // 参考时区沿用预报页的 Asia/Tokyo（当前城市集全为该时区）；
  // 若未来出现多时区城市，需逐城计算下界而非统一用参考时区
  const cutoff = daysAgoLocalDateKey("Asia/Tokyo", 6)

  const [citiesRes, dailyRes, userRes] = await Promise.all([
    supabase.from("cities").select("*").eq("is_active", true).order("name_en"),
    supabase
      .from("weather_daily")
      .select("*")
      .gte("day", cutoff)
      .order("day", { ascending: true })
      .order("source"),
    supabase.auth.getUser(),
  ])

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <HistoryView
        cities={(citiesRes.data ?? []) as CityRow[]}
        rows={(dailyRes.data ?? []) as DailyRow[]}
        isAdmin={isAdminEmail(userRes.data.user?.email)}
        initialCityName={initialCityName}
      />
    </div>
  )
}
