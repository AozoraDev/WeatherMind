import { getTranslations } from "next-intl/server"

import { LogsView } from "@/components/dashboard/logs/logs-view"
import { redirect } from "@/i18n/navigation"
import { isAdminEmail } from "@/lib/weather/admin"
import type { RunRow } from "@/lib/weather/view-types"
import { createClient } from "@/supabase/server"

// 日志页：仅管理员可见可进（侧边栏隐藏 + 此处重定向兜底），
// 展示 weather_runs 采集运行记录，按开始时间倒序取最近 100 条
export default async function LogsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const t = await getTranslations("dashboard.logs")
  const supabase = await createClient()

  const [runsRes, userRes] = await Promise.all([
    supabase
      .from("weather_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(100),
    supabase.auth.getUser(),
  ])

  // 路由守卫：非管理员即使直访 /dashboard/logs 也重定向回仪表盘
  if (!isAdminEmail(userRes.data.user?.email)) {
    redirect({ href: "/dashboard", locale })
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <LogsView runs={(runsRes.data ?? []) as RunRow[]} />
    </div>
  )
}
