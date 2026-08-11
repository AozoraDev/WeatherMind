import type { ChatUsage } from "@/lib/schemas/forecast-agent"

import {
  type ChatMessage,
  type ProviderErrorCode,
  type ToolCall,
} from "./chat"

// ReAct 循环的共享内核（非流式 runReActLoop 已随 core 路径废弃删除）：
// 类型、JSON 解析、usage 合并、工具执行/消息构造供 react-stream.ts 复用，
// 保证流式循环与其余逻辑口径一致。

export type ReactTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => string // 返回观察结果 JSON 字符串
}

export type ReactAction = { name: string; args: string; result: string }
export type ReactTraceStep = { thought: string | null; actions: ReactAction[] }
export type ReactTrace = ReactTraceStep[]

export type ReactLoopResult =
  | { ok: true; content: string; usage: ChatUsage | null; trace: ReactTrace }
  | { ok: false; error: ProviderErrorCode | "react-loop" }

// JSON.parse 的严格封装：失败返回 ok:false，成功把 any 收窄为 unknown
export function safeParseJson(
  s: string
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown }
  } catch {
    return { ok: false }
  }
}

// usage 跨步累计；某步代理未回传 usage 时跳过该步（保留已累计值）。
// 导出供 react-stream.ts 复用
export function mergeUsage(
  a: ChatUsage | null,
  b: ChatUsage | null
): ChatUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  }
}

// 工具调用执行 + 消息构造：react-stream.ts 消费，防两处口径漂移。
// 坏工具调用不中止——把 error JSON 当观察喂回模型让它自纠错（与既有语义一致）
export function executeToolCalls(
  tools: ReactTool[],
  toolCalls: ToolCall[]
): { actions: ReactAction[]; toolMsgs: ChatMessage[] } {
  const actions: ReactAction[] = []
  const toolMsgs: ChatMessage[] = []
  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.name)
    let result: string
    if (!tool) {
      result = JSON.stringify({ error: `unknown tool: ${tc.name}` })
    } else {
      // 参数解析：非法 JSON / 非对象 → 错误观察喂回模型，让它自纠错
      const parsed = safeParseJson(tc.arguments)
      if (!parsed.ok) {
        result = JSON.stringify({ error: "arguments are not valid JSON" })
      } else if (
        typeof parsed.value !== "object" ||
        parsed.value === null ||
        Array.isArray(parsed.value)
      ) {
        result = JSON.stringify({ error: "arguments must be a JSON object" })
      } else {
        try {
          result = tool.execute(parsed.value as Record<string, unknown>)
        } catch {
          result = JSON.stringify({ error: "tool execution failed" })
        }
      }
    }
    actions.push({ name: tc.name, args: tc.arguments, result })
    toolMsgs.push({ role: "tool", tool_call_id: tc.id, content: result })
  }
  return { actions, toolMsgs }
}
