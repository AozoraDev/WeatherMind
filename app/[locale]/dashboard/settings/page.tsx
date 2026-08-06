import { getTranslations } from "next-intl/server"

import { PagePlaceholder } from "@/components/dashboard/page-placeholder"

// 设置空页：功能未开发，先承接侧边栏跳转，避免 404
export default async function SettingsPage() {
  const t = await getTranslations("dashboard.settings")

  return <PagePlaceholder title={t("title")} desc={t("desc")} />
}
