"use client"

import { useTranslations } from "next-intl"

import { ButtonBlue } from "@/components/ui-preset/button"
import { useRouter } from "@/i18n/navigation"

// 提示页的「去配置模型」按钮：跳设置页；模型配置保存后 localStorage 订阅自动刷新，
// 用户返回 AI 助手页即渲染聊天界面
export function SetupGuide() {
  const t = useTranslations("dashboard.aiAgent.setup")
  const router = useRouter()

  return (
    <ButtonBlue onClick={() => router.push("/dashboard/settings")}>
      {t("goSettings")}
    </ButtonBlue>
  )
}
