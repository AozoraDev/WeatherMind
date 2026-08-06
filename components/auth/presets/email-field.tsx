"use client"

import { type AnyFieldApi } from "@tanstack/react-form"
import { useTranslations } from "next-intl"

import { AuthField } from "./auth-field"

type EmailFieldProps = {
  field: AnyFieldApi
  /** 验码步骤锁定邮箱，禁止修改 */
  disabled?: boolean
}

// 邮箱字段预设：邮箱类型 + 固定占位与自动填充语义，登录 / 注册 / 忘记密码共用
export function EmailField({ field, disabled }: EmailFieldProps) {
  const t = useTranslations("auth")

  return (
    <AuthField
      label={t("email")}
      errors={field.state.meta.errors}
      inputProps={{
        id: field.name,
        name: field.name,
        type: "email",
        placeholder: "you@example.com",
        autoComplete: "email",
        disabled,
        value: field.state.value,
        onChange: (e) => field.handleChange(e.target.value),
        onBlur: field.handleBlur,
      }}
    />
  )
}
