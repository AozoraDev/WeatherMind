"use client"

import { type ComponentProps } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { FieldError } from "./field-error"

type AuthFieldProps = {
  label: string
  errors: readonly unknown[]
  inputProps: ComponentProps<typeof Input>
}

// 认证表单字段容器：标签 + 输入框 + 内联错误，供登录 / 注册 / 忘记密码复用
export function AuthField({ label, errors, inputProps }: AuthFieldProps) {
  return (
    <div className="flex flex-col gap-1.5 text-left">
      <Label htmlFor={inputProps.id}>{label}</Label>
      <Input aria-invalid={errors.length > 0} {...inputProps} />
      <FieldError errors={errors} />
    </div>
  )
}
