import { isAllowedBaseUrl, hostResolvesToPublic } from "./ssrf"

// OpenAI 兼容 chat 调用的共享原语：baseUrl 由用户自配（存 localStorage），
// 服务端发起请求前先过 SSRF 防护（ssrf.ts）。SSRF 前置、wire 消息/工具互转、
// 请求体构建都在这里，供流式调用（chat-stream.ts）与 ReAct 循环复用。
// 非流式 chatCompletion 已随 core 路径废弃删除，仅剩流式路径（chat-stream.ts）

// 错误码（provider 调用返回）与内部消息模型：assistant 可带 tool_calls（ReAct 循环回传用），tool 角色承载工具观察结果。
export type ProviderErrorCode =
  "invalid-url" | "blocked" | "network" | "http" | "parse"
// 发送给 provider 前需经 toWireMessage 还原成 OpenAI wire 形态（见下）
export type ToolCall = { id: string; name: string; arguments: string }

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

// 工具定义：parameters 为 JSON-schema（tools.ts 手写并置，与 zod 校验器同形）
export type ChatTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// 内部消息 → OpenAI wire 形态：assistant 的 tool_calls 需还原 {id,type:"function",function:{name,arguments}}。
// 与 chat-stream.ts 共用（经 buildChatRequestBody），导出供测试直测
export function toWireMessage(m: ChatMessage): unknown {
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  }
  return m // system/user/tool 原样透传
}

export function toWireTool(t: ChatTool): unknown {
  return {
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }
}

// —— 共享原语（chat 与 chat-stream 共用，防两处口径漂移） ——

// SSRF 前置：字面量白名单 + 二次 DNS 复核，任一不过返回错误码（blocked）；通过返回 null
export async function assertPublicBaseUrl(
  baseUrl: string
): Promise<ProviderErrorCode | null> {
  if (!isAllowedBaseUrl(baseUrl)) return "blocked"
  // 绕过字面量检查的公共域名若解析到内网同样拦截
  const host = new URL(baseUrl).hostname
  if (!(await hostResolvesToPublic(host))) return "blocked"
  return null
}

// wire 请求体：temperature 固定 0 保证确定性输出；流式带 stream:true；
// tools 可选（ReAct 循环传入供模型调用），为空时省略，行为与单次直出完全一致
export function buildChatRequestBody(
  params: { model: string; messages: ChatMessage[]; tools?: ChatTool[] },
  stream: boolean
): Record<string, unknown> {
  return {
    model: params.model,
    messages: params.messages.map(toWireMessage),
    temperature: 0,
    ...(stream ? { stream: true } : {}),
    ...(params.tools && params.tools.length > 0
      ? { tools: params.tools.map(toWireTool) }
      : {}),
  }
}

// 解析 choices[0].message → 内部 content/toolCalls 形态（wire tool_calls 扁平化）
export function parseChatMessage(
  msg:
    | {
        content: string | null
        tool_calls?: {
          id: string
          function: { name: string; arguments: string }
        }[]
      }
    | null
    | undefined
): { content: string | null; toolCalls: ToolCall[] } {
  const content = msg?.content ?? null
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }))
  return { content, toolCalls }
}

// 非流式 chat 调用已废弃删除：生产路径只有流式（chat-stream.ts 的 chatCompletionStream），
// 其 JSON 降级分支内联了空响应校验（既无内容又无工具调用归 parse）
