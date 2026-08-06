"use client"

import { useTranslations } from "next-intl"

// 字段级错误：标准 schema 校验产出的 issue（message 即 auth.errors 的 i18n key），
// 逐条翻译展示；同时兼容 string 类型的自定义错误
export function FieldError({ errors }: { errors: readonly unknown[] }) {
  const t = useTranslations("auth.errors")

  const messages = errors
    .map((e) =>
      typeof e === "string" ? e : (e as { message?: string }).message
    )
    .filter((m): m is string => Boolean(m))

  if (messages.length === 0) return null

  return (
    <p className="text-xs text-destructive">
      {messages.map((m) => t(m)).join("、")}
    </p>
  )
}
