import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchStream } from "@/lib/weather/http"

import { chatCompletionStream, type ChatStreamEvent } from "./chat-stream"
import { resolveHostAll } from "./dns"

vi.mock("@/lib/weather/http", () => ({ fetchStream: vi.fn() }))
vi.mock("./dns", () => ({ resolveHostAll: vi.fn() }))

const mockedFetchStream = vi.mocked(fetchStream)
const mockedResolve = vi.mocked(resolveHostAll)

const CHAT_PARAMS = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "gpt-test",
  messages: [{ role: "system" as const, content: "你是预报助手" }],
}

// —— chatCompletionStream（流式） ——
// 桩 fetchStream 返回假响应：SSE 走 ReadableStream body；JSON 降级走 json()。
// 收集生成器事件断言流形态（delta 累计 / tool_calls 按 index / usage / done）

async function collectEvents(
  res: { ok: true; events: AsyncGenerator<ChatStreamEvent, unknown, unknown> }
): Promise<unknown[]> {
  const list: unknown[] = []
  for await (const ev of res.events) list.push(ev)
  return list
}

// JSON 降级响应的假 Response（content-type: application/json + json()）
function jsonResponse(json: unknown): Response {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => json,
  } as unknown as Response
}

function sseResponse(frames: string[], contentType = "text/event-stream") {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return {
    headers: new Headers({ "content-type": contentType }),
    body: stream,
  } as unknown as Response
}

describe("chatCompletionStream", () => {
  afterEach(() => {
    // 两个桩都要清：DNS 复核 mock 不清会跨用例累计调用记录，误判 blocked 用例
    mockedFetchStream.mockReset()
    mockedResolve.mockReset()
  })

  it("SSE 流：delta 累计 + tool_calls 按 index 分片拼全 + usage 透传 + done", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "## 推理" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "过程" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "query_source", arguments: '{"so' } },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'urce":"openweather"}' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: sseResponse(frames),
    })

    const res = await chatCompletionStream(CHAT_PARAMS)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const events = await collectEvents(res)
      // 工具参数按 index 分片累加为完整 JSON
      expect(events).toEqual([
        { type: "delta", text: "## 推理" },
        { type: "delta", text: "过程" },
        {
          type: "tool",
          index: 0,
          id: "c1",
          name: "query_source",
          argumentsDelta: '{"so',
        },
        {
          type: "tool",
          index: 0,
          id: "c1",
          name: "query_source",
          argumentsDelta: 'urce":"openweather"}',
        },
        {
          type: "done",
          content: "## 推理过程",
          toolCalls: [
            { id: "c1", name: "query_source", arguments: '{"source":"openweather"}' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      ])
    }
    // 请求体带 stream:true 且走 fetchStream
    expect(mockedFetchStream).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        body: JSON.stringify({
          model: "gpt-test",
          messages: CHAT_PARAMS.messages,
          temperature: 0,
          stream: true,
        }),
      }),
      expect.any(Number)
    )
  })

  it("SSE 流：坏帧静默跳过，不中断后续 delta", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "A" } }] })}\n\n`,
      "data: not-json\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "B" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: sseResponse(frames),
    })
    const res = await chatCompletionStream(CHAT_PARAMS)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const events = await collectEvents(res)
      expect(events).toEqual([
        { type: "delta", text: "A" },
        { type: "delta", text: "B" },
        { type: "done", content: "AB", toolCalls: [], usage: null },
      ])
    }
  })

  it("provider 忽略 stream → JSON 单帧降级为 delta + done", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    })
    const res = await chatCompletionStream(CHAT_PARAMS)
    expect(res.ok).toBe(true)
    if (res.ok)
      expect(await collectEvents(res)).toEqual([
        { type: "delta", text: "hi" },
        { type: "done", content: "hi", toolCalls: [], usage: null },
      ])
  })

  it("JSON 降级：含 tool_calls 时整体作为一次 tool 事件", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "c1", function: { name: "get_metric", arguments: "{}" } },
              ],
            },
          },
        ],
      }),
    })
    const res = await chatCompletionStream(CHAT_PARAMS)
    expect(res.ok).toBe(true)
    if (res.ok)
      expect(await collectEvents(res)).toEqual([
        {
          type: "tool",
          index: 0,
          id: "c1",
          name: "get_metric",
          argumentsDelta: "{}",
        },
        {
          type: "done",
          content: null,
          toolCalls: [{ id: "c1", name: "get_metric", arguments: "{}" }],
          usage: null,
        },
      ])
  })

  it("JSON 降级响应非法 → parse（等不到流末直接报错）", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: jsonResponse({ choices: [] }),
    })
    await expect(chatCompletionStream(CHAT_PARAMS)).resolves.toEqual({
      ok: false,
      error: "parse",
    })
  })

  it("JSON 降级 json() 抛错 → parse", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: {
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => {
          throw new Error("invalid body")
        },
      } as unknown as Response,
    })
    await expect(chatCompletionStream(CHAT_PARAMS)).resolves.toEqual({
      ok: false,
      error: "parse",
    })
  })

  it("SSE 多工具调用按 index 排序后拼全（顺序错乱的工具调用）", async () => {
    // index 1 先出、index 0 后出：done 前必须按 index 升序归并（杀 sort 突变）
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    const frames = [
      `data: ${JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "get_metric", arguments: '{"k":"v2"}' } }] } },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "query_source", arguments: '{"k":"v1"}' } }] } },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: sseResponse(frames),
    })
    const res = await chatCompletionStream(CHAT_PARAMS)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const events = await collectEvents(res)
      const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>
      expect(done.toolCalls).toEqual([
        { id: "c1", name: "query_source", arguments: '{"k":"v1"}' },
        { id: "c2", name: "get_metric", arguments: '{"k":"v2"}' },
      ])
    }
  })


  it("SSE 流：id/name 每分片重复提供 → 首现赋值不拼接，done 工具调用完整", async () => {
    // 部分 OpenAI 兼容端点每帧重复完整 id/name：若按追加会拼出 id"c1c1"/name"get_metricget_metric"，
    // 应只在首帧赋值、arguments 跨帧追加
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    const frames = [
      `data: ${JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_metric", arguments: '{"k":' } }] } },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_metric", arguments: '"v"}' } }] } },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: sseResponse(frames),
    })
    const res = await chatCompletionStream(CHAT_PARAMS)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const events = await collectEvents(res)
      const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>
      expect(done.toolCalls).toEqual([
        { id: "c1", name: "get_metric", arguments: '{"k":"v"}' },
      ])
    }
  })

  it("传入 signal → 透传给 fetchStream 的 init.signal（断线取消入口）", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: sseResponse(["data: [DONE]\n\n"]),
    })
    const controller = new AbortController()
    const res = await chatCompletionStream(CHAT_PARAMS, {
      signal: controller.signal,
    })
    expect(res.ok).toBe(true)
    expect(mockedFetchStream.mock.calls[0][1]?.signal).toBe(controller.signal)
  })

  it("Content-Type 非流式也非 JSON → parse", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({
      ok: true,
      response: {
        headers: new Headers({ "content-type": "text/html" }),
        body: new ReadableStream(),
      } as unknown as Response,
    })
    await expect(chatCompletionStream(CHAT_PARAMS)).resolves.toEqual({
      ok: false,
      error: "parse",
    })
  })

  it("fetchStream 非 2xx → http", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({ ok: false, error: "http" })
    await expect(chatCompletionStream(CHAT_PARAMS)).resolves.toEqual({
      ok: false,
      error: "http",
    })
  })

  it("fetchStream 网络异常 → network", async () => {
    mockedResolve.mockResolvedValue([{ address: "1.2.3.4", family: 4 }])
    mockedFetchStream.mockResolvedValue({ ok: false, error: "network" })
    await expect(chatCompletionStream(CHAT_PARAMS)).resolves.toEqual({
      ok: false,
      error: "network",
    })
  })

  it("baseUrl 私网 → blocked，不发请求也不解析 DNS", async () => {
    const res = await chatCompletionStream({
      ...CHAT_PARAMS,
      baseUrl: "https://192.168.1.1/v1",
    })
    expect(res).toEqual({ ok: false, error: "blocked" })
    expect(mockedFetchStream).not.toHaveBeenCalled()
    expect(mockedResolve).not.toHaveBeenCalled()
  })

  it("DNS 复核不过 → blocked", async () => {
    mockedResolve.mockResolvedValue([{ address: "10.0.0.5", family: 4 }])
    await expect(chatCompletionStream(CHAT_PARAMS)).resolves.toEqual({
      ok: false,
      error: "blocked",
    })
    expect(mockedFetchStream).not.toHaveBeenCalled()
  })
})
