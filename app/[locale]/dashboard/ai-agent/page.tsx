import { getTranslations } from "next-intl/server"

import { PagePlaceholder } from "@/components/dashboard/page-placeholder"

// AI 助手空页：功能未开发，先承接侧边栏跳转，避免 404
export default async function AiAgentPage() {
  const t = await getTranslations("dashboard.aiAgent")

  return <PagePlaceholder title={t("title")} desc={t("desc")} />
}
