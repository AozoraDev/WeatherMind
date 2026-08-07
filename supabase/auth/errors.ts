import type { AuthError as SupabaseAuthError } from "@supabase/supabase-js"

// UI 可展示的受限错误码：服务端把 Supabase 原始错误映射为这些 code，
// 客户端按 code 取 i18n 文案，不向用户泄露原始错误信息
export type AuthErrorCode =
  | "invalidCredentials"
  | "emailNotConfirmed"
  | "userExists"
  | "invalidOtp"
  | "rateLimited"
  | "userNotFound"
  | "passwordTooShort"
  | "passwordSameAsOld"
  | "invalidInput"
  | "network"
  | "generic"

// 把 Supabase 鉴权错误码映射为受限错误码
export function mapAuthError(
  err: Pick<SupabaseAuthError, "code" | "message" | "name">
): AuthErrorCode {
  // 网络层错误（fetch 失败 / 超时），与业务错误区分
  if (err.name === "AuthRetryableFetchError") return "network"

  switch (err.code) {
    case "invalid_credentials":
      return "invalidCredentials"
    case "email_not_confirmed":
      return "emailNotConfirmed"
    case "email_exists":
    case "user_already_exists":
      return "userExists"
    case "user_not_found":
      return "userNotFound"
    case "otp_expired":
    case "otp_disabled":
    case "bad_code_verifier":
      return "invalidOtp"
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "rateLimited"
    case "weak_password":
      return "passwordTooShort"
    case "email_address_invalid":
      return "invalidInput"
    default:
      return "generic"
  }
}

// 客户端表单动作错误：mutationFn 中 `!res.ok` 时抛出，供 mutation.error.code 取 i18n 文案
export class AuthError extends Error {
  code: AuthErrorCode

  constructor(code: AuthErrorCode) {
    super(code)
    this.name = "AuthError"
    this.code = code
  }
}
