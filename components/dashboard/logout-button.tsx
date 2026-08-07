"use client"

import { LogOut } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMutation } from "@tanstack/react-query"

import { ButtonBlue } from "@/components/ui-preset/button"
import { useToast } from "@/components/ui-preset/toast"
import { useRouter } from "@/i18n/navigation"
import { logoutAction } from "@/supabase/auth/actions"
import { AuthError } from "@/supabase/auth/errors"

// 退出登录按钮：调服务端动作清除会话，成功后弹提示并跳回落地页
export function LogoutButton() {
  const t = useTranslations("dashboard")
  const router = useRouter()
  const toast = useToast()

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await logoutAction()
      if (!res.ok) throw new AuthError(res.error)
    },
    onSuccess: () => {
      toast.success(t("success.logout"))
      router.push("/")
    },
    onError: () => toast.error(t("errors.logout")),
  })

  return (
    <ButtonBlue
      size="lg"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <LogOut aria-hidden="true" />
      {t("logout")}
    </ButtonBlue>
  )
}
