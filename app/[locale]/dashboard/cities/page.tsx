import { getTranslations } from "next-intl/server"

import { CitiesView } from "@/components/dashboard/cities/cities-view"
import { createClient } from "@/supabase/server"
import { redirect } from "@/i18n/navigation"
import { isAdminEmail } from "@/lib/weather/admin"
import {
  DEFAULT_PAGE_SIZE,
  parsePagination,
} from "@/lib/schemas/pagination"
import { fetchPage } from "@/lib/weather/pagination"
import type { CityRow } from "@/lib/weather/view-types"

// 城市页：服务端按 ?page= 分页取城市列表与管理员态（页长固定每页 20 条），
// 交给客户端视图渲染表格与增删交互；页码越界（如删除末页城市后仍停在高页码）时重定向回最后一页
export default async function CitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { locale } = await params
  const t = await getTranslations("dashboard.cities")
  const supabase = await createClient()
  const { page } = parsePagination(await searchParams)

  const [pageRes, userRes] = await Promise.all([
    fetchPage<CityRow>(
      supabase.from("cities").select("*", { count: "exact" }).order("name_en"),
      page,
      DEFAULT_PAGE_SIZE
    ),
    supabase.auth.getUser(),
  ])

  // 越界兜底：数据变少导致请求页大于总页数时，收敛到最后一页避免空白
  if (page > pageRes.totalPages) {
    redirect({
      href: {
        pathname: "/dashboard/cities",
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
      <CitiesView
        cities={pageRes.rows}
        pagination={pageRes}
        isAdmin={isAdminEmail(userRes.data.user?.email)}
      />
    </div>
  )
}
