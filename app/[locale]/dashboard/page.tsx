import { getTranslations } from "next-intl/server"

import { PagePlaceholder } from "@/components/dashboard/page-placeholder"

// 仪表盘占位页：天气功能尚未开发，先承接登录后的重定向目标，避免 404
export default async function DashboardPage() {
  const t = await getTranslations("dashboard")

  return <PagePlaceholder title={t("title")} desc={t("desc")} />
}
