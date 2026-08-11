import {
  chatResponseSchema,
  chatUsageSchema,
  type ChatUsage,
} from "@/lib/schemas/forecast-agent"
import { fetchStream } from "@/lib/weather/http"
import {
  extractDataPayloads,
  isDonePayload,
  splitSseEvents,
} from "@/lib/weather/sse"
import {
  assertPublicBaseUrl,
  buildChatRequestBody,
  parseChatMessage,
  type ChatMessage,
  type ChatTool,
  type ProviderErrorCode,
  type ToolCall,
} from "./chat"

// OpenAI 兼容 chat 流式调用：SSRF 前置与 chat.ts 一致；
// 响应按 Content-Type 分发——text/event-stream → SSE 流；application/json（provider 忽略 stream）
// → 单帧降级（完整结果当一次性 delta 发出）；其余 → parse。

// —— 流式 chat ——
// 事件流：delta = content 增量；tool = 工具调用增量片段（按 index 累计）；done = 流结束（含组装结果）
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "tool"
      index: number
      id: string
      name: string
      argumentsDelta: string // 该帧的工具参数字符串增量（调用方按 index 拼全）
    }
  | {
      type: "done"
      content: string | null
      toolCalls: ToolCall[]
      usage: ChatUsage | null
    }

export type ChatCompletionStreamResult =
  | { ok: true; events: AsyncGenerator<ChatStreamEvent> }
  | { ok: false; error: ProviderErrorCode }

// 一次性生成器：把非流式 JSON 降级的完整结果当 delta + tool + done 发出（复用 readJsonDegrade）
async function* emitDegrade(
  content: string | null,
  toolCalls: ToolCall[],
  usage: ChatUsage | null
): AsyncGenerator<ChatStreamEvent> {
  if (content) yield { type: "delta", text: content }
  for (const [i, tc] of toolCalls.entries()) {
    yield {
      type: "tool",
      index: i,
      id: tc.id,
      name: tc.name,
      argumentsDelta: tc.arguments,
    }
  }
  yield { type: "done", content, toolCalls, usage }
}

// 逐块读取上游 SSE 流并解包成 ChatStreamEvent。
// 坏帧（JSON.parse 失败）静默跳过不中断；tool_calls 按 index 累计；usage 从任意帧取；
// 流末发 done（content = 全部 delta 拼接，toolCalls = 按 index 拼全）
async function* readSseChatStream(res: Response): AsyncGenerator<ChatStreamEvent> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const contentParts: string[] = []
  const toolCallsByIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()
  let usage: ChatUsage | null = null

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { blocks, rest } = splitSseEvents(buffer)
      buffer = rest
      for (const block of blocks) {
        for (const payload of extractDataPayloads(block)) {
          if (isDonePayload(payload)) continue // [DONE] 哨兵：以 reader done 为真正的流结束
          let frame: unknown
          try {
            frame = JSON.parse(payload)
          } catch {
            continue // 坏帧静默跳过
          }
          const f = frame as {
            choices?: {
              delta?: { content?: unknown; tool_calls?: unknown[] }
            }[]
            usage?: unknown
          }
          // 部分代理在流中（含末帧）回传 usage；safeParse 兜底字段漂移
          if (f.usage) {
            const u = chatUsageSchema.safeParse(f.usage)
            if (u.success) usage = u.data
          }
          const delta = f.choices?.[0]?.delta
          if (!delta) continue
          if (typeof delta.content === "string" && delta.content) {
            contentParts.push(delta.content)
            yield { type: "delta", text: delta.content }
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const raw of delta.tool_calls) {
              const tc = raw as {
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }
              const idx = tc.index ?? 0
              const cur =
                toolCallsByIndex.get(idx) ?? { id: "", name: "", arguments: "" }
              // id/name/arguments 按分片追加（OpenAI 把一次工具调用切成多帧）
              if (typeof tc.id === "string") cur.id += tc.id
              if (tc.function?.name) cur.name += tc.function.name
              if (tc.function?.arguments)
                cur.arguments += tc.function.arguments
              toolCallsByIndex.set(idx, cur)
              yield {
                type: "tool",
                index: idx,
                id: cur.id,
                name: cur.name,
                argumentsDelta: tc.function?.arguments ?? "",
              }
            }
          }
        }
      }
    }
  } finally {
    // 调用方提前 break 时关闭底层流防连接挂起；正常结束 cancel 是 no-op
    try {
      reader.cancel()
    } catch {
      // 流已结束则忽略
    }
  }

  const toolCalls: ToolCall[] = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }))
  const content = contentParts.join("")
  yield { type: "done", content: content || null, toolCalls, usage }
}

// 流式 chat 调用：SSRF 前置与 chatCompletion 完全一致；
// 响应按 Content-Type 分发——text/event-stream → SSE 流；application/json（provider 忽略 stream）
// → 单帧降级（完整结果当一次性 delta 发出）；其余 → parse。降级路径的解析错误在此直接报错
export async function chatCompletionStream(
  params: {
    baseUrl: string
    apiKey: string
    model: string
    messages: ChatMessage[]
    tools?: ChatTool[]
  },
  opts?: { timeoutMs?: number }
): Promise<ChatCompletionStreamResult> {
  const baseUrl = params.baseUrl.trim().replace(/\/+$/, "")
  // SSRF 前置与 chatCompletion 共用同一实现，防两处口径漂移
  const preflight = await assertPublicBaseUrl(baseUrl)
  if (preflight) return { ok: false, error: preflight }

  const res = await fetchStream(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(buildChatRequestBody(params, true)),
    },
    opts?.timeoutMs ?? 30_000
  )
  if (!res.ok)
    return { ok: false, error: res.error === "network" ? "network" : "http" }

  const ctype = res.response.headers.get("content-type") ?? ""
  if (ctype.includes("application/json")) {
    // 非流式 provider 降级：完整结果读回并校验，失败直接报 parse（不等流末）
    let json: unknown
    try {
      json = await res.response.json()
    } catch {
      return { ok: false, error: "parse" }
    }
    const parsed = chatResponseSchema.safeParse(json)
    if (!parsed.success) return { ok: false, error: "parse" }
    const { content, toolCalls } = parseChatMessage(
      parsed.data.choices[0]?.message
    )
    // 既无内容又无工具调用 = 空响应，归 parse（与 chatCompletion 口径一致）
    if (!content && toolCalls.length === 0) return { ok: false, error: "parse" }
    return {
      ok: true,
      events: emitDegrade(content, toolCalls, parsed.data.usage ?? null),
    }
  }
  if (!ctype.includes("text/event-stream")) return { ok: false, error: "parse" }

  return { ok: true, events: readSseChatStream(res.response) }
}
