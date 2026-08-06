import { getTranslations } from "next-intl/server"

import { AuthCard } from "@/components/auth/presets/auth-card"
import { RegisterForm } from "@/components/auth/register-form"

// 注册页：统一鉴权外壳 + 注册表单（发验证码 → 验码）
export default async function RegisterPage() {
  const t = await getTranslations("register")

  return (
    <AuthCard title={t("title")} subtitle={t("subtitle")}>
      <RegisterForm />
    </AuthCard>
  )
}
