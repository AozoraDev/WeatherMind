import { DashboardHomeView } from "@/components/dashboard/home/dashboard-home-view"
import { createClient } from "@/supabase/server"
import { isAdminEmail } from "@/lib/weather/admin"

// 仪表盘首页：登录后的总览页，渲染欢迎横幅 + 功能入口卡片；
// 服务端读会话判定管理员态，控制「采集日志」入口卡的显隐（与侧栏口径一致）
export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const isAdmin = isAdminEmail(user?.email)

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <DashboardHomeView isAdmin={isAdmin} />
    </div>
  )
}
