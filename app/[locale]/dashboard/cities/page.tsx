import { getTranslations } from "next-intl/server"

import { CitiesView } from "@/components/dashboard/weather/cities-view"
import { createClient } from "@/lib/supabase/server"
import { isAdminEmail } from "@/lib/weather/admin"
import type { CityRow } from "@/lib/weather/view-types"

// 城市页：服务端取城市列表与管理员态，交给客户端视图渲染表格与增删交互
export default async function CitiesPage() {
  const t = await getTranslations("dashboard.cities")
  const supabase = await createClient()

  const [citiesRes, userRes] = await Promise.all([
    supabase.from("cities").select("*").order("name_en"),
    supabase.auth.getUser(),
  ])

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <CitiesView
        cities={(citiesRes.data ?? []) as CityRow[]}
        isAdmin={isAdminEmail(userRes.data.user?.email)}
      />
    </div>
  )
}
