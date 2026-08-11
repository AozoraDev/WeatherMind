import { afterEach, describe, expect, it, vi } from "vitest"

import {
  assertPublicBaseUrl,
  buildChatRequestBody,
  parseChatMessage,
  toWireMessage,
} from "./chat"
import { resolveHostAll } from "./dns"

vi.mock("./dns", () => ({ resolveHostAll: vi.fn() }))

const mockedResolve = vi.mocked(resolveHostAll)

// 非流式 chatCompletion 已废弃删除，这里直测幸存共享原语：
// wire 请求体（toWireMessage/toWireTool 经 buildChatRequestBody 进入）、
// wire message 扁平化（parseChatMessage）、SSRF 前置（assertPublicBaseUrl）

const SYSTEM = { role: "system" as const, content: "你是预报助手" }

describe("buildChatRequestBody（wire 请求体）", () => {
  it("非流式：temperature=0、无 stream 字段、tools 为空时省略", () => {
    expect(
      buildChatRequestBody({ model: "gpt-test", messages: [SYSTEM] }, false)
    ).toEqual({
      model: "gpt-test",
      messages: [SYSTEM],
      temperature: 0,
    })
  })

  it("流式：带 stream:true", () => {
    expect(
      buildChatRequestBody({ model: "gpt-test", messages: [SYSTEM] }, true)
    ).toEqual({
      model: "gpt-test",
      messages: [SYSTEM],
      temperature: 0,
      stream: true,
    })
  })

  it("tools 非空 → 随请求体发送（toWireTool 的 function 形态）", () => {
    const tools = [
      { name: "get_metric", description: "d", parameters: { type: "object" } },
    ]
    expect(
      buildChatRequestBody({ model: "m", messages: [SYSTEM], tools }, false)
    ).toEqual({
      model: "m",
      messages: [SYSTEM],
      temperature: 0,
      tools: [
        {
          type: "function",
          function: {
            name: "get_metric",
            description: "d",
            parameters: { type: "object" },
          },
        },
      ],
    })
  })

  it("tools 为空数组 → 省略 tools 字段（防空工具定义入体）", () => {
    expect(
      buildChatRequestBody({ model: "m", messages: [SYSTEM], tools: [] }, false)
    ).toEqual({
      model: "m",
      messages: [SYSTEM],
      temperature: 0,
    })
  })

  it("assistant tool_calls 消息还原为 wire 形态（toWireMessage）", () => {
    const messages = [
      { role: "system" as const, content: "s" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "c1",
            name: "query_source",
            arguments: '{"source":"openweather"}',
          },
        ],
      },
      { role: "tool" as const, tool_call_id: "c1", content: "{}" },
    ]
    expect(
      buildChatRequestBody({ model: "m", messages }, false).messages
    ).toEqual([
      { role: "system", content: "s" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "query_source",
              arguments: '{"source":"openweather"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "{}" },
    ])
  })
})

describe("toWireMessage（无 tool_calls 时原样透传）", () => {
  it("system/tool/无 tool_calls 的 assistant 均不改写", () => {
    const m = { role: "system" as const, content: "s" }
    expect(toWireMessage(m)).toBe(m)
    const assistant = { role: "assistant" as const, content: "hi" }
    expect(toWireMessage(assistant)).toBe(assistant)
  })
})

describe("parseChatMessage（wire message 扁平化）", () => {
  it("content + tool_calls → 内部 content/toolCalls 形态", () => {
    expect(
      parseChatMessage({
        content: "hi",
        tool_calls: [
          { id: "c1", function: { name: "get_metric", arguments: "{}" } },
        ],
      })
    ).toEqual({
      content: "hi",
      toolCalls: [{ id: "c1", name: "get_metric", arguments: "{}" }],
    })
  })

  it("null/undefined 消息 → content null、无工具调用", () => {
    expect(parseChatMessage(null)).toEqual({ content: null, toolCalls: [] })
    expect(parseChatMessage(undefined)).toEqual({
      content: null,
      toolCalls: [],
    })
  })
})

describe("assertPublicBaseUrl（SSRF 前置）", () => {
  afterEach(() => {
    mockedResolve.mockReset()
  })

  it("私网 https baseUrl 直接拒绝，不解析 DNS", async () => {
    expect(await assertPublicBaseUrl("https://192.168.1.1/v1")).toBe("blocked")
    expect(mockedResolve).not.toHaveBeenCalled()
  })

  it("非 https 公网域名拒绝，不解析 DNS", async () => {
    expect(await assertPublicBaseUrl("http://api.openai.com/v1")).toBe(
      "blocked"
    )
    expect(mockedResolve).not.toHaveBeenCalled()
  })

  it("DNS 复核解析到内网 → blocked", async () => {
    mockedResolve.mockResolvedValue([{ address: "10.0.0.5", family: 4 }])
    expect(await assertPublicBaseUrl("https://example.com/v1")).toBe("blocked")
  })

  it("DNS 复核全为公网 → 通过（返回 null）", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    expect(await assertPublicBaseUrl("https://api.example.com/v1")).toBeNull()
  })
})
