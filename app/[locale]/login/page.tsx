import { getTranslations } from "next-intl/server"

import { AuthCard } from "@/components/auth/presets/auth-card"
import { LoginForm } from "@/components/auth/login-form"

// 登录页：统一鉴权外壳 + 登录表单（服务端鉴权）
export default async function LoginPage() {
  const t = await getTranslations("login")

  return (
    <AuthCard title={t("title")} subtitle={t("subtitle")}>
      <LoginForm />
    </AuthCard>
  )
}
