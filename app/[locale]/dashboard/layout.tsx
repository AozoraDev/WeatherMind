import { DashboardNavbar } from "@/components/dashboard/navbar"
import { Sidenav } from "@/components/dashboard/sidenav"
import { redirect } from "@/i18n/navigation"
import { isAdminEmail } from "@/lib/weather/admin"
import { createClient } from "@/supabase/server"

// 仪表盘布局：左侧固定导航栏 + 右侧顶部导航与内容区；
// 服务端读会话取用户邮箱，未登录兜底跳回落地页（常规拦截由 proxy 承担）
export default async function DashboardLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode
  params: Promise<{ locale: string }>
}>) {
  const { locale } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect({ href: "/", locale })
  const email = user?.email ?? ""
  // 管理员标识传给侧边栏，控制「日志」等管理员专属入口的显隐
  const isAdmin = isAdminEmail(email)

  return (
    <div className="flex h-svh bg-background">
      <Sidenav isAdmin={isAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardNavbar email={email} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
