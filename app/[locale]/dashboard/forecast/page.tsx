import { getTranslations } from "next-intl/server"

import { PagePlaceholder } from "@/components/dashboard/page-placeholder"

// 预报空页：功能未开发，先承接侧边栏跳转，避免 404
export default async function ForecastPage() {
  const t = await getTranslations("dashboard.forecast")

  return <PagePlaceholder title={t("title")} desc={t("desc")} />
}
