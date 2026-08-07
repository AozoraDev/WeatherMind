"use server"

import { createClient as createSupabaseClient } from "@supabase/supabase-js"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  forgotSchema,
  loginSchema,
  registerSchema,
  verifyResetSchema,
  verifySchema,
  type ForgotValues,
  type LoginValues,
  type RegisterValues,
  type VerifyResetValues,
  type VerifyValues,
} from "@/lib/schemas/auth"

import { mapAuthError, type AuthErrorCode } from "./errors"

// 动作统一返回结果对象而非抛错：跨 RPC 边界抛出会破坏错误序列化，
// 由客户端 mutationFn 将 !ok 转为 AuthError 驱动 UI
export type AuthResult = { ok: true } | { ok: false; error: AuthErrorCode }

// 退出登录：清除服务端会话 Cookie，成功后由客户端跳转落地页
export async function logoutAction(): Promise<AuthResult> {
  const supabase = await createClient()
  const { error } = await supabase.auth.signOut()
  if (error) return { ok: false, error: mapAuthError(error) }
  return { ok: true }
}

// 登录：校验凭据并建立会话（认证 Cookie 由服务端 client 写入）
export async function loginAction(values: LoginValues): Promise<AuthResult> {
  const parsed = loginSchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  if (error) return { ok: false, error: mapAuthError(error) }
  return { ok: true }
}

// 注册 step1：先做「邮箱已注册」预检，未注册才创建用户并发验证码（需项目侧开启 Confirm email）
// checkExists 仅首次发送时传 true：重发时账号刚由 signUp 创建、存在是正常态，跳过预检
export async function registerSendCodeAction(
  values: RegisterValues,
  opts?: { checkExists?: boolean }
): Promise<AuthResult> {
  const parsed = registerSchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }

  // 已注册邮箱不发验证码，直接返回专用错误码让客户端弹 toast
  if (opts?.checkExists) {
    try {
      const { data: exists, error: checkError } = await createServiceClient().rpc(
        "is_email_registered",
        { p_email: parsed.data.email }
      )
      if (checkError) return { ok: false, error: mapAuthError(checkError) }
      if (exists) return { ok: false, error: "userExists" }
    } catch {
      return { ok: false, error: "generic" }
    }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  })
  if (error) return { ok: false, error: mapAuthError(error) }
  return { ok: true }
}

// 注册 step2：校验验证码确认邮箱，成功后即建立会话
export async function registerVerifyCodeAction(
  values: VerifyValues
): Promise<AuthResult> {
  const parsed = verifySchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }

  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({
    email: parsed.data.email,
    token: parsed.data.code,
    type: "signup",
  })
  if (error) return { ok: false, error: mapAuthError(error) }
  return { ok: true }
}

// 忘记密码 step1：先用新密码试登录判断「新旧密码是否相同」，再按邮箱发送重置验证码
// （新密码仅在客户端暂存，验码后才落库）
export async function forgotSendCodeAction(
  values: ForgotValues
): Promise<AuthResult> {
  const parsed = forgotSchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }

  const { email, newPassword } = parsed.data

  // 新旧密码相同与否只能靠「能否用新密码登录」来判断：能登进 → 新密码等于老密码，
  // 返回专用错误码让客户端弹 toast，不发验证码
  const checkClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } }
  )
  const { error: checkError } = await checkClient.auth.signInWithPassword({
    email,
    password: newPassword,
  })
  if (!checkError) return { ok: false, error: "passwordSameAsOld" }

  // 登不进且是「凭据错误」→ 说明新密码确实不同于老密码，放行；
  // 其余错误（网络/限流/未确认邮箱等）按通用映射拦截
  if (checkError.code !== "invalid_credentials") {
    return { ok: false, error: mapAuthError(checkError) }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email)
  if (error) return { ok: false, error: mapAuthError(error) }
  return { ok: true }
}

// 忘记密码 step2：验码 → 落新密码 → 重新登录兜底（updateUser 后原会话可能失效）
export async function forgotVerifyCodeAction(
  values: VerifyResetValues
): Promise<AuthResult> {
  const parsed = verifyResetSchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }

  const supabase = await createClient()
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: parsed.data.email,
    token: parsed.data.code,
    type: "recovery",
  })
  if (verifyError) return { ok: false, error: mapAuthError(verifyError) }

  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  })
  if (updateError) return { ok: false, error: mapAuthError(updateError) }

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.newPassword,
  })
  if (signInError) return { ok: false, error: mapAuthError(signInError) }

  return { ok: true }
}
