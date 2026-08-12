import { describe, expect, it } from "vitest"

import {
  chatRequestBodySchema,
  conversationMessageSchema,
  conversationMessagesSchema,
  deleteConversationSchema,
} from "./ai-agent"

// zod 信任边界测试：缺失/非法字段、类型漂移、越界（rules/testing.md 需测 Zod 边界）
const validMessage = { role: "user", content: "你好", created_at: "2026-08-11T00:00:00Z" }

describe("conversationMessageSchema", () => {
  it("合法消息通过", () => {
    expect(conversationMessageSchema.safeParse(validMessage).success).toBe(true)
  })

  it("role 越界（非 user/assistant）→ 失败", () => {
    const result = conversationMessageSchema.safeParse({
      ...validMessage,
      role: "system",
    })
    expect(result.success).toBe(false)
  })

  it("content 缺失/非字符串 → 失败", () => {
    expect(
      conversationMessageSchema.safeParse({
        role: "user",
        created_at: "2026-08-11T00:00:00Z",
      }).success
    ).toBe(false)
    expect(
      conversationMessageSchema.safeParse({
        ...validMessage,
        content: 42,
      }).success
    ).toBe(false)
  })

  it("created_at 缺失 → 失败", () => {
    expect(
      conversationMessageSchema.safeParse({
        role: "user",
        content: "你好",
      }).success
    ).toBe(false)
  })

  it("assistant 消息带合法 usage → 通过", () => {
    expect(
      conversationMessageSchema.safeParse({
        role: "assistant",
        content: "你好！",
        created_at: "2026-08-11T00:00:00Z",
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }).success
    ).toBe(true)
  })

  it("usage 字段漂移（缺 total_tokens）→ 失败", () => {
    expect(
      conversationMessageSchema.safeParse({
        role: "assistant",
        content: "你好！",
        created_at: "2026-08-11T00:00:00Z",
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }).success
    ).toBe(false)
  })
})

describe("conversationMessagesSchema", () => {
  it("空数组与合法数组均通过", () => {
    expect(conversationMessagesSchema.safeParse([]).success).toBe(true)
    expect(
      conversationMessagesSchema.safeParse([
        validMessage,
        { role: "assistant", content: "你好！", created_at: "2026-08-11T00:00:01Z" },
      ]).success
    ).toBe(true)
  })

  it("数组中混入非法项 → 整体失败", () => {
    expect(
      conversationMessagesSchema.safeParse([
        validMessage,
        { role: "tool", content: "x", created_at: "2026-08-11T00:00:01Z" },
      ]).success
    ).toBe(false)
  })
})

describe("chatRequestBodySchema", () => {
  const validBody = {
    conversationId: "a5e6a111-6b61-4e0f-91c2-5f2f3e4a5b6c",
    content: "  你好  ",
    locale: "zh",
    model: { baseUrl: "https://api.example.com/v1", apiKey: "sk-123", model: "gpt-4o" },
  }

  it("合法请求体通过，content 已 trim", () => {
    const parsed = chatRequestBodySchema.safeParse(validBody)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.content).toBe("你好")
  })

  it("locale 越界（非 zh/en）→ 失败", () => {
    expect(
      chatRequestBodySchema.safeParse({ ...validBody, locale: "ja" }).success
    ).toBe(false)
  })

  it("conversationId 非法 uuid → 失败", () => {
    expect(
      chatRequestBodySchema.safeParse({ ...validBody, conversationId: "not-a-uuid" })
        .success
    ).toBe(false)
  })

  it("content 空白 → 失败", () => {
    expect(
      chatRequestBodySchema.safeParse({ ...validBody, content: "   " }).success
    ).toBe(false)
  })

  it("model 配置漂移（缺 apiKey）→ 失败", () => {
    expect(
      chatRequestBodySchema.safeParse({
        ...validBody,
        model: { baseUrl: "https://api.example.com/v1", model: "gpt-4o" },
      }).success
    ).toBe(false)
  })
})

describe("deleteConversationSchema", () => {
  it("合法 uuid 通过，非法 uuid 失败", () => {
    expect(
      deleteConversationSchema.safeParse({
        id: "a5e6a111-6b61-4e0f-91c2-5f2f3e4a5b6c",
      }).success
    ).toBe(true)
    expect(deleteConversationSchema.safeParse({ id: "abc" }).success).toBe(false)
  })
})
