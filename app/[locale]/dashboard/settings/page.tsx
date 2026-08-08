import { getTranslations } from "next-intl/server"

import { ModelConfigCard } from "@/components/dashboard/settings/model-config-card"
import { createClient } from "@/supabase/server"

// 设置页：展示模型配置卡片；email 用于按用户隔离的本地配置缓存键
export default async function SettingsPage() {
  const t = await getTranslations("dashboard.settings")
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const email = user?.email ?? ""

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <ModelConfigCard email={email} />
    </div>
  )
}
