"use client"

import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { useTranslations } from "next-intl"

import { ButtonBlue, ButtonGreen } from "@/components/ui-preset/button"
import { useToast } from "@/components/ui-preset/toast"
import { Link, useRouter } from "@/i18n/navigation"
import { loginAction } from "@/supabase/auth/actions"
import { AuthError } from "@/supabase/auth/errors"
import { loginSchema, type LoginValues } from "@/lib/schemas/auth"

import { AuthField } from "./presets/auth-field"

// 登录表单：TanStack Form 校验 → useMutation 调服务端动作 → 成功弹浅绿提示并跳首页
export function LoginForm() {
  const t = useTranslations("auth")
  const router = useRouter()
  const toast = useToast()

  // 动作失败统一弹红色提示，按受限错误码取 i18n 文案
  const showError = (err: unknown) => {
    if (err instanceof AuthError) toast.error(t(`errors.${err.code}`))
  }

  const mutation = useMutation({
    mutationFn: async (values: LoginValues) => {
      const res = await loginAction(values)
      if (!res.ok) throw new AuthError(res.error)
    },
    onSuccess: () => {
      toast.success(t("success.login"))
      router.push("/")
    },
    onError: showError,
  })

  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: loginSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value)
    },
  })

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <form.Field name="email">
        {(field) => (
          <AuthField
            label={t("email")}
            errors={field.state.meta.errors}
            inputProps={{
              id: field.name,
              name: field.name,
              type: "email",
              placeholder: "you@example.com",
              autoComplete: "email",
              value: field.state.value,
              onChange: (e) => field.handleChange(e.target.value),
              onBlur: field.handleBlur,
            }}
          />
        )}
      </form.Field>

      <form.Field name="password">
        {(field) => (
          <AuthField
            label={t("password")}
            errors={field.state.meta.errors}
            inputProps={{
              id: field.name,
              name: field.name,
              type: "password",
              placeholder: "••••••••",
              autoComplete: "current-password",
              value: field.state.value,
              onChange: (e) => field.handleChange(e.target.value),
              onBlur: field.handleBlur,
            }}
          />
        )}
      </form.Field>

      <ButtonBlue
        type="submit"
        size="lg"
        className="w-full"
        disabled={mutation.isPending}
      >
        {t("loginSubmit")}
      </ButtonBlue>

      {/* 跳转入口：忘记密码 / 去注册分行排布，统一套绿色预设按钮渲染成 Link */}
      <div className="flex flex-col gap-3">
        <ButtonGreen
          size="sm"
          nativeButton={false}
          render={<Link href="/forgot-password" />}
        >
          {t("forgotLink")}
        </ButtonGreen>
        <ButtonGreen
          size="sm"
          nativeButton={false}
          render={<Link href="/register" />}
        >
          {t("toRegister")}
        </ButtonGreen>
      </div>
    </form>
  )
}
