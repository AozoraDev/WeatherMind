import { getTranslations } from "next-intl/server"

import { LogsView } from "@/components/dashboard/logs/logs-view"
import { redirect } from "@/i18n/navigation"
import { isAdminEmail } from "@/lib/weather/admin"
import {
  DEFAULT_PAGE_SIZE,
  parsePagination,
} from "@/lib/schemas/pagination"
import { fetchPage } from "@/lib/weather/pagination"
import type { RunRow } from "@/lib/weather/view-types"
import { createClient } from "@/supabase/server"

// 日志页：仅管理员可见可进（侧边栏隐藏 + 此处重定向兜底），
// 展示 weather_runs 采集运行记录，按开始时间倒序分页（页长固定每页 20 条）；
// 页码越界时重定向回最后一页
export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { locale } = await params
  const t = await getTranslations("dashboard.logs")
  const supabase = await createClient()
  const { page } = parsePagination(await searchParams)

  const [pageRes, userRes] = await Promise.all([
    fetchPage<RunRow>(
      supabase
        .from("weather_runs")
        .select("*", { count: "exact" })
        .order("started_at", { ascending: false }),
      page,
      DEFAULT_PAGE_SIZE
    ),
    supabase.auth.getUser(),
  ])

  // 路由守卫：非管理员即使直访 /dashboard/logs 也重定向回仪表盘
  if (!isAdminEmail(userRes.data.user?.email)) {
    redirect({ href: "/dashboard", locale })
  }

  // 越界兜底：数据变少导致请求页大于总页数时，收敛到最后一页避免空白
  if (page > pageRes.totalPages) {
    redirect({
      href: {
        pathname: "/dashboard/logs",
        query: { page: pageRes.totalPages },
      },
      locale,
    })
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      {/* flex-1 占满剩余高度：表格卡片 h-full 承接后内部滚动，分页条不被挤出视口 */}
      <div className="min-h-0 flex-1">
        <LogsView runs={pageRes.rows} pagination={pageRes} />
      </div>
    </div>
  )
}
