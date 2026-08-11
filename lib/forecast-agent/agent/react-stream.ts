import type { ChatUsage } from "@/lib/schemas/forecast-agent"

import type { ChatMessage, ChatTool, ToolCall } from "./chat"
import { chatCompletionStream } from "./chat-stream"
import {
  executeToolCalls,
  mergeUsage,
  type ReactLoopResult,
  type ReactTool,
  type ReactTrace,
} from "./react"

// —— 流式 ReAct 循环 ——
// delta = 终态答案（Markdown 全文）增量（token 级）；thought = 工具步模型的思考文字
// （空串表示步边界——该步无思考文本时也发，供客户端把后续 tool 归入本步）；
// rollback = 思考文字已按 delta 透传进 Markdown，客户端据此从尾部回滚（它不属于最终答案正文）；
// tool = 某工具已执行（args 为完整参数字符串，result 为观察结果 JSON，供卡片实时展示）；
// result = 循环结束（含 content/usage/trace 或错误码）。工具步内部消费上游流，最终步才对外流式
export type ReActLoopStreamEvent =
  | { type: "delta"; text: string }
  | { type: "thought"; text: string }
  | { type: "rollback"; chars: number }
  | { type: "tool"; name: string; args: string; result: string }
  | { type: "result"; result: ReactLoopResult }

// 工具逐个展示的节奏：真实执行是同步即时完成（数据已在内存），
// 故意留出小间隔，让「逐条查源」的过程在推理卡上可见，而非一次性全部跳出
const TOOL_PACE_MS = 400
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function* runReActLoopStream(params: {
  model: { baseUrl: string; apiKey: string; model: string }
  messages: ChatMessage[]
  tools: ReactTool[]
  timeoutMs?: number // 默认 45_000
  maxSteps?: number // 默认 4
  // 每步工具轮完成后回调当前累计轨迹（进度落库用）；抛错/拒绝不得中止循环
  onTrace?: (trace: ReactTrace) => void | Promise<void>
}): AsyncGenerator<ReActLoopStreamEvent> {
  const {
    model,
    messages,
    tools,
    timeoutMs = 45_000,
    maxSteps = 4,
    onTrace,
  } = params
  const toolDefs: ChatTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))

  const history: ChatMessage[] = [...messages]
  const trace: ReactTrace = []
  let usage: ChatUsage | null = null

  for (let step = 0; step < maxSteps; step++) {
    const streamRes = await chatCompletionStream(
      { ...model, messages: history, tools: toolDefs },
      { timeoutMs }
    )
    if (!streamRes.ok) {
      yield { type: "result", result: { ok: false, error: streamRes.error } }
      return
    }

    // 消费本步流：delta 累计 content；tool 按 index 累计工具调用
    const contentParts: string[] = []
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; arguments: string }
    >()
    let stepToolCalls: ToolCall[] = []

    try {
      for await (const ev of streamRes.events) {
        if (ev.type === "delta") {
          contentParts.push(ev.text)
          // 即时透传增量：真流式靠这里逐块 yield，不能攒到步末一次性输出。
          // 工具步的 content（若有）即思考文字，也经此透传，步末随 rollback 从 Markdown 回滚
          yield { type: "delta", text: ev.text }
        } else if (ev.type === "tool") {
          const cur = toolCallsByIndex.get(ev.index) ?? {
            id: "",
            name: "",
            arguments: "",
          }
          cur.id += ev.id
          cur.name += ev.name
          cur.arguments += ev.argumentsDelta
          toolCallsByIndex.set(ev.index, cur)
        } else if (ev.type === "done") {
          stepToolCalls = ev.toolCalls
          usage = mergeUsage(usage, ev.usage)
          break
        }
      }
    } catch {
      // 上游流中途断开（网络错误）：本轮无法得到完整结果，归 network
      yield { type: "result", result: { ok: false, error: "network" } }
      return
    }

    if (stepToolCalls.length > 0) {
      // 工具步：本步 content（若有）即模型的思考文字。流式期已作 delta 透传，这里发 thought
      // 供推理卡展示，并发 rollback 让客户端从 Markdown 尾部回滚（不属于最终答案正文）；
      // 无 content 也发空串 thought 作为步边界，客户端据此把后续 tool 归入本步
      const thoughtText = contentParts.join("")
      yield { type: "thought", text: thoughtText }
      if (thoughtText) yield { type: "rollback", chars: thoughtText.length }
      const { actions, toolMsgs } = executeToolCalls(tools, stepToolCalls)
      // 逐个 yield 工具事件，间隔展示（推理卡逐条出现，非一次性全跳出）
      for (const [i, a] of actions.entries()) {
        yield { type: "tool", name: a.name, args: a.args, result: a.result }
        if (i < actions.length - 1) await sleep(TOOL_PACE_MS)
      }
      trace.push({ thought: thoughtText || null, actions })
      // 进度回调：await 保证按步序写库；写失败吞掉继续循环（与既有语义一致）
      if (onTrace) {
        try {
          await onTrace(trace)
        } catch {
          // 进度写失败仅丢实时轨迹，不中止推理
        }
      }
      history.push(
        { role: "assistant", content: null, tool_calls: stepToolCalls },
        ...toolMsgs
      )
      continue
    }

    // 最终步（无工具调用）：content 即终态答案；各 delta 已在消费循环内即时 yield，
    // 这里只校验空响应并给出完整结果（含拼接后的全文）
    const content = contentParts.join("")
    // 空响应（坏流/空帧）归 react-loop，与既有空响应兜底一致
    if (!content.trim()) {
      yield { type: "result", result: { ok: false, error: "react-loop" } }
      return
    }
    yield { type: "result", result: { ok: true, content, usage, trace } }
    return
  }

  // 步数耗尽仍未给出终态答案
  yield { type: "result", result: { ok: false, error: "react-loop" } }
}
