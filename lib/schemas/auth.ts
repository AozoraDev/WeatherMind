import { z } from "zod"

// 认证共享 schema：错误 message 统一为 i18n key（对应 auth.errors.* 段），
// 字段级校验由 TanStack Form 在前端 onSubmit 触发，服务端动作再用 safeParse 复核

// 邮箱：zod v4 顶层 email 校验
const email = z.email("invalidEmail")
// 密码：至少 6 位（Supabase 默认密码强度下限）
const password = z.string().min(6, "passwordTooShort")
// 验证码：8 位数字（Supabase 邮箱 OTP 模板 {{ .Token }} 的格式）
const code = z.string().regex(/^\d{8}$/, "invalidCode")
// 验证码或空串：两段式表单 step1 时为空通过，step2 时按 8 位数字校验
const codeOrEmpty = z.string().regex(/^(\d{8})?$/, "invalidCode")

// 登录：邮箱 + 密码
export const loginSchema = z.object({ email, password })

// 注册：单个 schema 覆盖两段式——step1 校验邮箱/密码/确认密码（code 为空通过），
// step2 校验验证码（密码字段保留原值仍通过）
export const registerSchema = z
  .object({
    email,
    password,
    confirmPassword: z.string(),
    code: codeOrEmpty,
  })
  .check(({ value, issues }) => {
    if (value.password !== value.confirmPassword) {
      issues.push({
        code: "custom",
        input: value,
        path: ["confirmPassword"],
        message: "passwordMismatch",
      })
    }
  })

// 注册验码（服务端）：邮箱 + 验证码，其余字段被剥离
export const verifySchema = z.object({ email, code })

// 忘记密码：单个 schema 覆盖两段式——step1 校验邮箱/新密码（code 为空通过），
// step2 校验验证码与新密码
// 注意：新旧密码相同的校验不在 schema 里做，而是留在服务端动作返回专用错误码，
// 以便客户端弹 toast（若放这里会被表单内联错误拦下，弹不出 toast）
export const forgotSchema = z
  .object({
    email,
    newPassword: password,
    confirmPassword: z.string(),
    code: codeOrEmpty,
  })
  .check(({ value, issues }) => {
    if (value.newPassword !== value.confirmPassword) {
      issues.push({
        code: "custom",
        input: value,
        path: ["confirmPassword"],
        message: "passwordMismatch",
      })
    }
  })

// 忘记密码验码（服务端）：邮箱 + 验证码 + 新密码
export const verifyResetSchema = z.object({
  email,
  code,
  newPassword: password,
})

export type LoginValues = z.infer<typeof loginSchema>
export type RegisterValues = z.infer<typeof registerSchema>
export type VerifyValues = z.infer<typeof verifySchema>
export type ForgotValues = z.infer<typeof forgotSchema>
export type VerifyResetValues = z.infer<typeof verifyResetSchema>
