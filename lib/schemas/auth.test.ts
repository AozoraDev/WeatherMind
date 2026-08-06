import { describe, expect, it } from "vitest"

import {
  forgotSchema,
  loginSchema,
  registerSchema,
  verifyResetSchema,
  verifySchema,
} from "./auth"

// 断言 safeParse 失败且指定路径的校验 message 符合预期
function expectMessage(
  result: {
    success: boolean
    error?: { issues: { path: PropertyKey[]; message: string }[] }
  },
  path: string,
  message: string
) {
  expect(result.success).toBe(false)
  expect(
    result.error?.issues.find((i) => i.path.join(".") === path)?.message
  ).toBe(message)
}

describe("loginSchema", () => {
  it("合法凭据通过", () => {
    expect(
      loginSchema.safeParse({ email: "a@b.com", password: "123456" }).success
    ).toBe(true)
  })

  it("非法邮箱报 invalidEmail", () => {
    expectMessage(
      loginSchema.safeParse({ email: "not-an-email", password: "123456" }),
      "email",
      "invalidEmail"
    )
  })

  it("密码不足 6 位报 passwordTooShort", () => {
    expectMessage(
      loginSchema.safeParse({ email: "a@b.com", password: "12345" }),
      "password",
      "passwordTooShort"
    )
  })

  it("缺少字段直接失败", () => {
    expect(loginSchema.safeParse({ email: "a@b.com" }).success).toBe(false)
  })
})

describe("registerSchema", () => {
  const valid = {
    email: "a@b.com",
    password: "123456",
    confirmPassword: "123456",
    code: "",
  }

  it("step1（验证码为空）通过", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true)
  })

  it("step2（8 位验证码）通过", () => {
    expect(
      registerSchema.safeParse({ ...valid, code: "12345678" }).success
    ).toBe(true)
  })

  it("两次密码不一致报 passwordMismatch", () => {
    expectMessage(
      registerSchema.safeParse({ ...valid, confirmPassword: "654321" }),
      "confirmPassword",
      "passwordMismatch"
    )
  })

  it("非法验证码报 invalidCode", () => {
    expectMessage(
      registerSchema.safeParse({ ...valid, code: "123" }),
      "code",
      "invalidCode"
    )
  })

  it("弱密码报 passwordTooShort", () => {
    expectMessage(
      registerSchema.safeParse({
        ...valid,
        password: "12345",
        confirmPassword: "12345",
      }),
      "password",
      "passwordTooShort"
    )
  })
})

describe("verifySchema", () => {
  it("邮箱 + 8 位验证码通过", () => {
    expect(
      verifySchema.safeParse({ email: "a@b.com", code: "12345678" }).success
    ).toBe(true)
  })

  it("非法验证码报 invalidCode", () => {
    expectMessage(
      verifySchema.safeParse({ email: "a@b.com", code: "123" }),
      "code",
      "invalidCode"
    )
  })

  it("缺少验证码失败", () => {
    expect(verifySchema.safeParse({ email: "a@b.com" }).success).toBe(false)
  })
})

describe("forgotSchema", () => {
  const valid = {
    email: "a@b.com",
    newPassword: "123456",
    confirmPassword: "123456",
    code: "",
  }

  it("step1（验证码为空）通过", () => {
    expect(forgotSchema.safeParse(valid).success).toBe(true)
  })

  it("新密码与确认不一致报 passwordMismatch", () => {
    expectMessage(
      forgotSchema.safeParse({ ...valid, confirmPassword: "654321" }),
      "confirmPassword",
      "passwordMismatch"
    )
  })

  it("新密码不足 6 位报 passwordTooShort", () => {
    expectMessage(
      forgotSchema.safeParse({
        ...valid,
        newPassword: "12345",
        confirmPassword: "12345",
      }),
      "newPassword",
      "passwordTooShort"
    )
  })
})

describe("verifyResetSchema", () => {
  it("邮箱 + 验证码 + 新密码通过", () => {
    expect(
      verifyResetSchema.safeParse({
        email: "a@b.com",
        code: "12345678",
        newPassword: "123456",
      }).success
    ).toBe(true)
  })

  it("非法验证码报 invalidCode", () => {
    expectMessage(
      verifyResetSchema.safeParse({
        email: "a@b.com",
        code: "123",
        newPassword: "123456",
      }),
      "code",
      "invalidCode"
    )
  })

  it("新密码不足 6 位报 passwordTooShort", () => {
    expectMessage(
      verifyResetSchema.safeParse({
        email: "a@b.com",
        code: "12345678",
        newPassword: "12345",
      }),
      "newPassword",
      "passwordTooShort"
    )
  })
})
