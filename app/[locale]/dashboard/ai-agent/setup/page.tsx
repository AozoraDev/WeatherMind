import { getTranslations } from "next-intl/server"

import { SetupGuide } from "@/components/dashboard/ai-agent/setup-guide"

// 未配置 AI 模型的提示页：由 AiAgentView 客户端重定向至此（模型配置只存 localStorage，
// 服务端无法判定）。文案提示 + 「去配置模型」按钮跳设置页，配置保存后返回 AI 助手即渲染聊天。
export default async function AiAgentSetupPage() {
  const t = await getTranslations("dashboard.aiAgent.setup")

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">
        {t("desc")}
      </p>
      <SetupGuide />
    </div>
  )
}
