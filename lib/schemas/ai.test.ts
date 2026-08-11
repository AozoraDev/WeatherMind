import { describe, expect, it } from "vitest"

import { connectionSchema, modelConfigSchema, modelsResponseSchema } from "./ai"

// 断言 safeParse 失败且指定路径的校验 message 符合预期（与 auth.test.ts 同款助手）
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

describe("connectionSchema", () => {
  it("合法地址与 Key 通过", () => {
    expect(
      connectionSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-123",
      }).success
    ).toBe(true)
  })

  it("空地址报 invalidUrl", () => {
    expectMessage(
      connectionSchema.safeParse({ baseUrl: "", apiKey: "sk-123" }),
      "baseUrl",
      "invalidUrl"
    )
  })

  it("非法地址报 invalidUrl", () => {
    expectMessage(
      connectionSchema.safeParse({ baseUrl: "not-a-url", apiKey: "sk-123" }),
      "baseUrl",
      "invalidUrl"
    )
  })

  it("空 Key 报 apiKeyRequired", () => {
    expectMessage(
      connectionSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
      }),
      "apiKey",
      "apiKeyRequired"
    )
  })

  it("纯空格 Key 视为空报 apiKeyRequired", () => {
    expectMessage(
      connectionSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "   ",
      }),
      "apiKey",
      "apiKeyRequired"
    )
  })
})

describe("modelConfigSchema", () => {
  it("连接字段 + 已选模型通过", () => {
    expect(
      modelConfigSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-123",
        model: "gpt-4o",
      }).success
    ).toBe(true)
  })

  it("未选模型报 modelRequired", () => {
    expectMessage(
      modelConfigSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-123",
        model: "",
      }),
      "model",
      "modelRequired"
    )
  })

  it("纯空格模型视为未选报 modelRequired", () => {
    expectMessage(
      modelConfigSchema.safeParse({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-123",
        model: "   ",
      }),
      "model",
      "modelRequired"
    )
  })
})

describe("modelsResponseSchema", () => {
  it("标准响应（含可选字段）通过", () => {
    expect(
      modelsResponseSchema.safeParse({
        data: [
          { id: "gpt-4o", object: "model", owned_by: "openai" },
          { id: "gpt-4o-mini" },
        ],
      }).success
    ).toBe(true)
  })

  it("data 缺失失败", () => {
    expect(modelsResponseSchema.safeParse({ foo: "bar" }).success).toBe(false)
  })

  it("模型项缺 id 失败", () => {
    expect(
      modelsResponseSchema.safeParse({ data: [{ object: "model" }] }).success
    ).toBe(false)
  })
})
