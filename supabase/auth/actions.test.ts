import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }))
vi.mock("@/supabase/server", () => ({ createClient: vi.fn() }))
vi.mock("@/supabase/service", () => ({ createServiceClient: vi.fn() }))

import { createClient as createRawClient } from "@supabase/supabase-js"
import { createClient } from "@/supabase/server"
import { createServiceClient } from "@/supabase/service"

import {
  forgotSendCodeAction,
  forgotVerifyCodeAction,
  loginAction,
  logoutAction,
  registerSendCodeAction,
  registerVerifyCodeAction,
} from "./actions"

// 构造带 auth 方法的客户端桩：auth 方法未设置的默认 resolve 无错误
function mockServerClient(auth: Record<string, unknown> = {}) {
  const client = { auth }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return client.auth as Record<string, Mock>
}

const loginValues = { email: "a@b.com", password: "123456" }
const registerValues = {
  email: "a@b.com",
  password: "123456",
  confirmPassword: "123456",
  code: "",
}
const verifyValues = { email: "a@b.com", code: "12345678" }
const forgotValues = {
  email: "a@b.com",
  newPassword: "123456",
  confirmPassword: "123456",
  code: "",
}
const verifyResetValues = {
  email: "a@b.com",
  code: "12345678",
  newPassword: "123456",
}

// 可被 mapAuthError 识别的 Supabase 错误
const supabaseError = {
  name: "AuthApiError",
  code: "invalid_credentials",
  message: "bad password",
}

function okResolve() {
  return vi.fn().mockResolvedValue({ error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("logoutAction", () => {
  it("成功退出 → ok", async () => {
    mockServerClient({ signOut: okResolve() })
    await expect(logoutAction()).resolves.toEqual({ ok: true })
  })

  it("signOut 报错 → 映射错误码", async () => {
    mockServerClient({
      signOut: vi.fn().mockResolvedValue({ error: supabaseError }),
    })
    await expect(logoutAction()).resolves.toEqual({
      ok: false,
      error: "invalidCredentials",
    })
  })
})

describe("loginAction", () => {
  it("schema 校验失败 → invalidInput", async () => {
    await expect(
      loginAction({ email: "not-an-email", password: "123" })
    ).resolves.toEqual({ ok: false, error: "invalidInput" })
  })

  it("成功登录 → ok", async () => {
    const auth = mockServerClient({ signInWithPassword: okResolve() })
    await expect(loginAction(loginValues)).resolves.toEqual({ ok: true })
    expect(auth.signInWithPassword).toHaveBeenCalledWith(loginValues)
  })

  it("登录失败 → 映射错误码", async () => {
    mockServerClient({
      signInWithPassword: vi.fn().mockResolvedValue({ error: supabaseError }),
    })
    await expect(loginAction(loginValues)).resolves.toEqual({
      ok: false,
      error: "invalidCredentials",
    })
  })
})

describe("registerSendCodeAction", () => {
  it("schema 校验失败（密码过短）→ invalidInput", async () => {
    await expect(
      registerSendCodeAction({ ...registerValues, password: "123" })
    ).resolves.toEqual({ ok: false, error: "invalidInput" })
  })

  it("默认不预检：直接 signUp 并成功", async () => {
    const auth = mockServerClient({ signUp: okResolve() })
    await expect(registerSendCodeAction(registerValues)).resolves.toEqual({
      ok: true,
    })
    expect(auth.signUp).toHaveBeenCalledWith({
      email: registerValues.email,
      password: registerValues.password,
    })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it("checkExists 预检发现已注册 → userExists，不发验证码", async () => {
    vi.mocked(createServiceClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    } as never)
    const auth = mockServerClient({ signUp: vi.fn() })

    const result = await registerSendCodeAction(registerValues, {
      checkExists: true,
    })

    expect(result).toEqual({ ok: false, error: "userExists" })
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(createServiceClient).toHaveBeenCalled()
  })

  it("checkExists 预检通过 → 继续 signUp", async () => {
    vi.mocked(createServiceClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
    } as never)
    const auth = mockServerClient({ signUp: okResolve() })

    await expect(
      registerSendCodeAction(registerValues, { checkExists: true })
    ).resolves.toEqual({ ok: true })
    expect(auth.signUp).toHaveBeenCalled()
  })

  it("checkExists 预检 RPC 报错 → 映射错误码", async () => {
    vi.mocked(createServiceClient).mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: null, error: supabaseError }),
    } as never)
    const result = await registerSendCodeAction(registerValues, {
      checkExists: true,
    })
    expect(result).toEqual({ ok: false, error: "invalidCredentials" })
  })

  it("checkExists 预检抛异常 → generic", async () => {
    vi.mocked(createServiceClient).mockReturnValue({
      rpc: vi.fn().mockRejectedValue(new Error("boom")),
    } as never)
    const result = await registerSendCodeAction(registerValues, {
      checkExists: true,
    })
    expect(result).toEqual({ ok: false, error: "generic" })
  })

  it("signUp 报错 → 映射错误码", async () => {
    mockServerClient({
      signUp: vi.fn().mockResolvedValue({ error: supabaseError }),
    })
    await expect(registerSendCodeAction(registerValues)).resolves.toEqual({
      ok: false,
      error: "invalidCredentials",
    })
  })
})

describe("registerVerifyCodeAction", () => {
  it("验证码格式非法 → invalidInput", async () => {
    await expect(
      registerVerifyCodeAction({ ...verifyValues, code: "123" })
    ).resolves.toEqual({ ok: false, error: "invalidInput" })
  })

  it("验码成功 → ok", async () => {
    const auth = mockServerClient({ verifyOtp: okResolve() })
    await expect(registerVerifyCodeAction(verifyValues)).resolves.toEqual({
      ok: true,
    })
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: verifyValues.email,
      token: verifyValues.code,
      type: "signup",
    })
  })

  it("验码失败 → 映射错误码", async () => {
    mockServerClient({
      verifyOtp: vi.fn().mockResolvedValue({ error: supabaseError }),
    })
    await expect(registerVerifyCodeAction(verifyValues)).resolves.toEqual({
      ok: false,
      error: "invalidCredentials",
    })
  })
})

describe("forgotSendCodeAction", () => {
  it("schema 校验失败 → invalidInput", async () => {
    await expect(
      forgotSendCodeAction({ ...forgotValues, newPassword: "123" })
    ).resolves.toEqual({ ok: false, error: "invalidInput" })
  })

  it("新密码能登进（等于旧密码）→ passwordSameAsOld，不发重置码", async () => {
    vi.mocked(createRawClient).mockReturnValue({
      auth: { signInWithPassword: okResolve() },
    } as never)

    const result = await forgotSendCodeAction(forgotValues)

    expect(result).toEqual({ ok: false, error: "passwordSameAsOld" })
    expect(createClient).not.toHaveBeenCalled()
  })

  it("登不进且是凭据错误 → 放行，发送重置码", async () => {
    vi.mocked(createRawClient).mockReturnValue({
      auth: {
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ error: supabaseError }),
      },
    } as never)
    const auth = mockServerClient({ resetPasswordForEmail: okResolve() })

    await expect(forgotSendCodeAction(forgotValues)).resolves.toEqual({
      ok: true,
    })
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(
      forgotValues.email
    )
  })

  it("登不进但非凭据错误（如限流）→ 按通用映射拦截", async () => {
    vi.mocked(createRawClient).mockReturnValue({
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue({
          error: { ...supabaseError, code: "over_email_send_rate_limit" },
        }),
      },
    } as never)

    const result = await forgotSendCodeAction(forgotValues)

    expect(result).toEqual({ ok: false, error: "rateLimited" })
    expect(createClient).not.toHaveBeenCalled()
  })

  it("发送重置码报错 → 映射错误码", async () => {
    vi.mocked(createRawClient).mockReturnValue({
      auth: {
        signInWithPassword: vi
          .fn()
          .mockResolvedValue({ error: supabaseError }),
      },
    } as never)
    mockServerClient({
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: supabaseError }),
    })

    await expect(forgotSendCodeAction(forgotValues)).resolves.toEqual({
      ok: false,
      error: "invalidCredentials",
    })
  })
})

describe("forgotVerifyCodeAction", () => {
  it("验码失败 → 映射错误码，不再落密码", async () => {
    const auth = mockServerClient({
      verifyOtp: vi.fn().mockResolvedValue({ error: supabaseError }),
      updateUser: vi.fn(),
      signInWithPassword: vi.fn(),
    })
    const result = await forgotVerifyCodeAction(verifyResetValues)
    expect(result).toEqual({ ok: false, error: "invalidCredentials" })
    expect(auth.updateUser).not.toHaveBeenCalled()
  })

  it("落新密码失败 → 映射错误码，不再重登", async () => {
    const auth = mockServerClient({
      verifyOtp: okResolve(),
      updateUser: vi.fn().mockResolvedValue({ error: supabaseError }),
      signInWithPassword: vi.fn(),
    })
    const result = await forgotVerifyCodeAction(verifyResetValues)
    expect(result).toEqual({ ok: false, error: "invalidCredentials" })
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })

  it("重登失败 → 映射错误码", async () => {
    mockServerClient({
      verifyOtp: okResolve(),
      updateUser: okResolve(),
      signInWithPassword: vi.fn().mockResolvedValue({ error: supabaseError }),
    })
    await expect(forgotVerifyCodeAction(verifyResetValues)).resolves.toEqual({
      ok: false,
      error: "invalidCredentials",
    })
  })

  it("验码 → 落新密码 → 重登全成功 → ok", async () => {
    const auth = mockServerClient({
      verifyOtp: okResolve(),
      updateUser: okResolve(),
      signInWithPassword: okResolve(),
    })
    await expect(forgotVerifyCodeAction(verifyResetValues)).resolves.toEqual({
      ok: true,
    })
    expect(auth.updateUser).toHaveBeenCalledWith({
      password: verifyResetValues.newPassword,
    })
  })
})
