import { getTranslations } from "next-intl/server"

import { AuthCard } from "@/components/auth/presets/auth-card"
import { ForgotForm } from "@/components/auth/forgot-form"

// 忘记密码页：统一鉴权外壳 + 重置表单（先填新密码发验证码 → 验码落库）
export default async function ForgotPasswordPage() {
  const t = await getTranslations("forgot")

  return (
    <AuthCard title={t("title")} subtitle={t("subtitle")}>
      <ForgotForm />
    </AuthCard>
  )
}
