"use client"

import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useState } from "react"

import { ButtonBlue, ButtonGreen } from "@/components/ui-preset/button"
import { useToast } from "@/components/ui-preset/toast"
import { Link, useRouter } from "@/i18n/navigation"
import {
  registerSendCodeAction,
  registerVerifyCodeAction,
} from "@/lib/supabase/auth/actions"
import { AuthError } from "@/lib/supabase/auth/errors"
import { registerSchema } from "@/lib/schemas/auth"

import { AuthField } from "./presets/auth-field"

// 表单值：step1 用邮箱/密码，step2 用邮箱/验证码；step 驱动 UI 与校验对象
type RegisterFormValues = {
  email: string
  password: string
  confirmPassword: string
  code: string
}

// 注册表单：两段式——先填邮箱与密码发验证码，再输验证码完成注册
export function RegisterForm() {
  const t = useTranslations("auth")
  const router = useRouter()
  const toast = useToast()
  const [step, setStep] = useState<"send" | "verify">("send")

  // 动作失败统一弹红色提示，按受限错误码取 i18n 文案
  const showError = (err: unknown) => {
    if (err instanceof AuthError) toast.error(t(`errors.${err.code}`))
  }

  const sendCode = useMutation({
    mutationFn: async (values: RegisterFormValues) => {
      const res = await registerSendCodeAction(values)
      if (!res.ok) throw new AuthError(res.error)
    },
    onSuccess: () => {
      toast.success(t("success.codeSent"))
      setStep("verify")
    },
    onError: showError,
  })

  const verify = useMutation({
    mutationFn: async (values: RegisterFormValues) => {
      const res = await registerVerifyCodeAction(values)
      if (!res.ok) throw new AuthError(res.error)
    },
    onSuccess: () => {
      toast.success(t("success.registered"))
      router.push("/")
    },
    onError: showError,
  })

  const form = useForm({
    defaultValues: { email: "", password: "", confirmPassword: "", code: "" },
    // 单个 schema 覆盖两段式：step1 code 为空通过，step2 校验 6 位验证码
    validators: { onSubmit: registerSchema },
    onSubmit: async ({ value }) => {
      if (step === "send") await sendCode.mutateAsync(value)
      else await verify.mutateAsync(value)
    },
  })

  const active = step === "send" ? sendCode : verify

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
              disabled: step === "verify",
              value: field.state.value,
              onChange: (e) => field.handleChange(e.target.value),
              onBlur: field.handleBlur,
            }}
          />
        )}
      </form.Field>

      {step === "send" ? (
        <>
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
                  autoComplete: "new-password",
                  value: field.state.value,
                  onChange: (e) => field.handleChange(e.target.value),
                  onBlur: field.handleBlur,
                }}
              />
            )}
          </form.Field>

          <form.Field name="confirmPassword">
            {(field) => (
              <AuthField
                label={t("confirmPassword")}
                errors={field.state.meta.errors}
                inputProps={{
                  id: field.name,
                  name: field.name,
                  type: "password",
                  placeholder: "••••••••",
                  autoComplete: "new-password",
                  value: field.state.value,
                  onChange: (e) => field.handleChange(e.target.value),
                  onBlur: field.handleBlur,
                }}
              />
            )}
          </form.Field>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("codeSent", { email: form.state.values.email })}
          </p>

          <form.Field name="code">
            {(field) => (
              <AuthField
                label={t("code")}
                errors={field.state.meta.errors}
                inputProps={{
                  id: field.name,
                  name: field.name,
                  type: "text",
                  inputMode: "numeric",
                  placeholder: "12345678",
                  autoComplete: "one-time-code",
                  value: field.state.value,
                  onChange: (e) => field.handleChange(e.target.value),
                  onBlur: field.handleBlur,
                }}
              />
            )}
          </form.Field>

          <button
            type="button"
            onClick={() => sendCode.mutate(form.state.values)}
            disabled={sendCode.isPending}
            className="self-start text-xs text-[#2563eb] hover:underline disabled:opacity-50"
          >
            {t("resendCode")}
          </button>
        </>
      )}

      <ButtonBlue
        type="submit"
        size="lg"
        className="w-full"
        disabled={active.isPending}
      >
        {t(step === "send" ? "sendCode" : "verifySubmit")}
      </ButtonBlue>

      {/* 跳转入口：去登录，套绿色预设按钮渲染成 Link */}
      <div className="flex justify-center">
        <ButtonGreen
          size="sm"
          nativeButton={false}
          render={<Link href="/login" />}
        >
          {t("toLogin")}
        </ButtonGreen>
      </div>
    </form>
  )
}
