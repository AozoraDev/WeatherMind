import { describe, expect, it } from "vitest"

import { AuthError, mapAuthError } from "./errors"

describe("mapAuthError", () => {
  it("网络层错误独立映射为 network", () => {
    expect(
      mapAuthError({ name: "AuthRetryableFetchError", code: "", message: "" })
    ).toBe("network")
  })

  // Supabase 各业务错误码 → 受限错误码
  it.each([
    ["invalid_credentials", "invalidCredentials"],
    ["email_not_confirmed", "emailNotConfirmed"],
    ["email_exists", "userExists"],
    ["user_already_exists", "userExists"],
    ["user_not_found", "userNotFound"],
    ["otp_expired", "invalidOtp"],
    ["otp_disabled", "invalidOtp"],
    ["bad_code_verifier", "invalidOtp"],
    ["over_email_send_rate_limit", "rateLimited"],
    ["over_request_rate_limit", "rateLimited"],
    ["weak_password", "passwordTooShort"],
    ["email_address_invalid", "invalidInput"],
  ])("code %s 映射为 %s", (code, expected) => {
    expect(mapAuthError({ name: "AuthApiError", code, message: "" })).toBe(
      expected
    )
  })

  it("未知或缺失 code 兜底为 generic", () => {
    expect(
      mapAuthError({ name: "AuthApiError", code: "unknown_code", message: "" })
    ).toBe("generic")
    expect(mapAuthError({ name: "AuthApiError", code: "", message: "" })).toBe(
      "generic"
    )
  })
})

describe("AuthError", () => {
  it("构造时记录受限错误码与 name", () => {
    const err = new AuthError("rateLimited")
    expect(err.code).toBe("rateLimited")
    expect(err.name).toBe("AuthError")
    expect(err.message).toBe("rateLimited")
  })
})
