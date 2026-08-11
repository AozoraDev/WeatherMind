import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ChatMessage } from "./chat"
import { chatCompletionStream, type ChatStreamEvent } from "./chat-stream"
import type { ReactTool, ReactTrace } from "./react"
import {
  runReActLoopStream,
  type ReActLoopStreamEvent,
} from "./react-stream"

vi.mock("./chat-stream", () => ({ chatCompletionStream: vi.fn() }))

const mockedChatStream = vi.mocked(chatCompletionStream)

// 假上游流：直接把 ChatStreamEvent 数组作为生成器事件源
async function* streamOf(
  events: ChatStreamEvent[]
): AsyncGenerator<ChatStreamEvent> {
  for (const e of events) yield e
}

// 消费 runReActLoopStream 产出的事件
async function consume(
  gen: AsyncGenerator<ReActLoopStreamEvent>
): Promise<ReActLoopStreamEvent[]> {
  const list: ReActLoopStreamEvent[] = []
  for await (const ev of gen) list.push(ev)
  return list
}

// 简单工具桩：回显参数，便于断言 execute 被调用的入参
const TOOLS: ReactTool[] = [
  {
    name: "query_source",
    description: "query a source snapshot",
    parameters: { type: "object" },
    execute: (args) => JSON.stringify({ got: args }),
  },
]

const MODEL = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-1",
  model: "gpt-x",
}
const INITIAL: ChatMessage[] = [
  { role: "system", content: "你是预报助手" },
  { role: "user", content: "请解读" },
]

beforeEach(() => {
  mockedChatStream.mockReset()
})

describe("runReActLoopStream", () => {
  const FINAL_MD = "## 推理过程\n因为。\n## 预报\n预测 30°C。"
  const TOOL_CALL = {
    id: "c1",
    name: "query_source",
    arguments: '{"source":"openweather"}',
  } as const

  it("一步直出：最终步 delta 逐块流式 + result 含完整 content", async () => {
    // delta 拼接必须等于 FINAL_MD（流式循环用 contentParts 拼接，不取 done.content）
    mockedChatStream.mockResolvedValueOnce({
      ok: true,
      events: streamOf([
        { type: "delta", text: "## 推理过程\n因为。\n" },
        { type: "delta", text: "## 预报\n预测 30°C。" },
        {
          type: "done",
          content: FINAL_MD,
          toolCalls: [],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      ]),
    })
    const events = await consume(
      runReActLoopStream({ model: MODEL, messages: INITIAL, tools: TOOLS })
    )
    expect(events).toEqual([
      { type: "delta", text: "## 推理过程\n因为。\n" },
      { type: "delta", text: "## 预报\n预测 30°C。" },
      {
        type: "result",
        result: {
          ok: true,
          content: FINAL_MD,
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          trace: [],
        },
      },
    ])
    expect(mockedChatStream).toHaveBeenCalledTimes(1)
  })

  it("工具轮：yield tool 事件、轨迹记录、usage 跨步累计、最终步流式", async () => {
    mockedChatStream
      .mockResolvedValueOnce({
        ok: true,
        events: streamOf([
          {
            type: "done",
            content: null,
            toolCalls: [TOOL_CALL],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        events: streamOf([
          { type: "delta", text: "## 预报\n晴。" },
          {
            type: "done",
            content: "## 预报\n晴。",
            toolCalls: [],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 7,
              total_tokens: 27,
            },
          },
        ]),
      })
    const traceLens: number[] = []
    const onTrace = vi.fn(async (t: ReactTrace) => {
      traceLens.push(t.length)
    })
    const events = await consume(
      runReActLoopStream({
        model: MODEL,
        messages: INITIAL,
        tools: TOOLS,
        onTrace,
      })
    )
    expect(events).toEqual([
      // 工具步无思考文本（content 为 null）→ 空串 thought 作步边界
      { type: "thought", text: "" },
      {
        type: "tool",
        name: "query_source",
        args: TOOL_CALL.arguments,
        result: '{"got":{"source":"openweather"}}',
      },
      { type: "delta", text: "## 预报\n晴。" },
      {
        type: "result",
        result: {
          ok: true,
          content: "## 预报\n晴。",
          // usage 逐字段求和（杀 mergeUsage 突变）
          usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
          trace: [
            {
              // 无思考文本 → thought 落 null（杀 thought 文本/|| null 突变）
              thought: null,
              actions: [
                {
                  name: "query_source",
                  args: TOOL_CALL.arguments,
                  result: '{"got":{"source":"openweather"}}',
                },
              ],
            },
          ],
        },
      },
    ])
    expect(traceLens).toEqual([1])
    expect(onTrace).toHaveBeenCalledTimes(1)
    // 第二轮请求携带回传的 assistant+tool 消息（杀 history.push 突变）
    const secondMessages = mockedChatStream.mock.calls[1][0].messages
    expect(secondMessages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"got":{"source":"openweather"}}',
    })
  })

  it("usage 某步缺省 → 保留已累计值（mergeUsage 处理 b 为 null）", async () => {
    mockedChatStream
      .mockResolvedValueOnce({
        ok: true,
        events: streamOf([
          {
            type: "done",
            content: null,
            toolCalls: [TOOL_CALL],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        events: streamOf([
          { type: "delta", text: "晴。" },
          { type: "done", content: "晴。", toolCalls: [], usage: null },
        ]),
      })
    const events = await consume(
      runReActLoopStream({ model: MODEL, messages: INITIAL, tools: TOOLS })
    )
    const result = events.at(-1)
    expect(result?.type).toBe("result")
    if (result?.type === "result")
      expect(result.result).toEqual({
        ok: true,
        content: "晴。",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        trace: expect.any(Array),
      })
  })

  it("provider 失败 → result 透传错误码", async () => {
    mockedChatStream.mockResolvedValueOnce({ ok: false, error: "network" })
    const events = await consume(
      runReActLoopStream({ model: MODEL, messages: INITIAL, tools: TOOLS })
    )
    expect(events).toEqual([
      { type: "result", result: { ok: false, error: "network" } },
    ])
  })

  it("工具步带思考文字（混合步）→ thought 透传、rollback 回滚、循环继续到终态", async () => {
    // 工具步先流 content（思考文字）又出工具调用：思考文字发 thought 供推理卡展示、
    // 并发 rollback 从 Markdown 回滚，循环不因混合步失败，继续到最终步
    mockedChatStream
      .mockResolvedValueOnce({
        ok: true,
        events: streamOf([
          { type: "delta", text: "等一下" },
          { type: "done", content: null, toolCalls: [TOOL_CALL], usage: null },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        events: streamOf([
          { type: "delta", text: "## 预报\n晴。" },
          {
            type: "done",
            content: "## 预报\n晴。",
            toolCalls: [],
            usage: null,
          },
        ]),
      })
    const events = await consume(
      runReActLoopStream({ model: MODEL, messages: INITIAL, tools: TOOLS })
    )
    expect(events).toEqual([
      // delta 已即时透传（真流式不可攒）
      { type: "delta", text: "等一下" },
      { type: "thought", text: "等一下" },
      // 思考文字长度 3，客户端据此从 markdown 尾部回滚
      { type: "rollback", chars: 3 },
      {
        type: "tool",
        name: "query_source",
        args: TOOL_CALL.arguments,
        result: '{"got":{"source":"openweather"}}',
      },
      { type: "delta", text: "## 预报\n晴。" },
      {
        type: "result",
        result: {
          ok: true,
          content: "## 预报\n晴。",
          usage: null,
          // 思考文字随轨迹落库（思考文字保存）
          trace: [
            {
              thought: "等一下",
              actions: [
                {
                  name: "query_source",
                  args: TOOL_CALL.arguments,
                  result: '{"got":{"source":"openweather"}}',
                },
              ],
            },
          ],
        },
      },
    ])
    // 混合步 history 仍带 assistant+tool 消息（思考文字作 assistant content 回传）
    const secondMessages = mockedChatStream.mock.calls[1][0].messages
    expect(secondMessages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"got":{"source":"openweather"}}',
    })
    expect(mockedChatStream).toHaveBeenCalledTimes(2)
  })

  it("最终步 content 为空 → react-loop", async () => {
    mockedChatStream.mockResolvedValueOnce({
      ok: true,
      events: streamOf([
        { type: "done", content: null, toolCalls: [], usage: null },
      ]),
    })
    const events = await consume(
      runReActLoopStream({ model: MODEL, messages: INITIAL, tools: TOOLS })
    )
    expect(events).toEqual([
      { type: "result", result: { ok: false, error: "react-loop" } },
    ])
  })

  it("步数耗尽仍只出工具调用 → react-loop", async () => {
    mockedChatStream.mockResolvedValue({
      ok: true,
      events: streamOf([
        { type: "done", content: null, toolCalls: [TOOL_CALL], usage: null },
      ]),
    })
    const events = await consume(
      runReActLoopStream({
        model: MODEL,
        messages: INITIAL,
        tools: TOOLS,
        maxSteps: 2,
      })
    )
    expect(events.at(-1)).toEqual({
      type: "result",
      result: { ok: false, error: "react-loop" },
    })
    expect(mockedChatStream).toHaveBeenCalledTimes(2)
  })
})
