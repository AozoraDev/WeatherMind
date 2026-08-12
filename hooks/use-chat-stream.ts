"use client"

import { useRef, useState } from "react"

import type { ChatSseEvent } from "@/lib/ai-agent/common/chat-events"
import type { ChatUsage } from "@/lib/schemas/agent-core"
import type { ProviderErrorCode } from "@/lib/agent-core/chat"
import type { ModelConfig } from "@/lib/model-config"
import type { A2uiMessage } from "@/lib/schemas/a2ui"
import { useSseStream } from "@/hooks/use-sse-stream"

// 前端消费 /api/ai-agent/chat 的 SSE 流。传输层（fetch/getReader/逐帧解析/错误码映射）
// 收敛在 useSseStream，这里只做「事件 → 内容」的分发：delta 逐字累积 assistantText、
// a2ui 暂存卡片消息串（done 前到达，随 onDone 一并回传）、done 收尾（顺带把本次
// token 消耗 usage 传给 onDone，供气泡下页脚展示）、error 带错误码。
// 本 hook 不持有消息列表（由父组件管理），只负责单次「发送 → 流式回复」的状态。
// 这是 rules/fetch-usage.md「客户端不裸 fetch」的受控例外。

export type ChatStreamStatus = "idle" | "streaming" | "done" | "error"

export type ChatStreamErrorCode =
  | ProviderErrorCode
  | "unauthorized"
  | "no-model"
  | "conversationNotFound"
  | "generic"

export type ChatStreamState = {
  status: ChatStreamStatus
  assistantText: string // 已流式累积的 assistant 回复全文
  a2uiMessages: A2uiMessage[] // 服务端下发的 a2ui 卡片消息串（done 前到达，用于流式期展示）
  errorCode: ChatStreamErrorCode | null
}

type UseChatStreamArgs = {
  model: ModelConfig | null // null = 未配置模型，start 直接报 no-model
  locale: "zh" | "en" // 传给服务端组织系统提示词
  onA2ui?: (messages: A2uiMessage[]) => void
  onDone?: (
    content: string | null,
    usage: ChatUsage | null,
    a2ui: A2uiMessage[] | null
  ) => void
  onError?: (code: ChatStreamErrorCode) => void
}

export function useChatStream({
  model,
  locale,
  onA2ui,
  onDone,
  onError,
}: UseChatStreamArgs) {
  const [assistantText, setAssistantText] = useState("")
  const textRef = useRef("")
  const [a2uiMessages, setA2uiMessages] = useState<A2uiMessage[]>([])
  const a2uiRef = useRef<A2uiMessage[] | null>(null)

  const sse = useSseStream<
    { conversationId: string; content: string },
    ChatStreamErrorCode,
    ChatSseEvent
  >({
    url: "/api/ai-agent/chat",
    model,
    buildBody: (params) => ({
      conversationId: params.conversationId,
      content: params.content,
      locale,
    }),
    onTransportError: "network",
    onNoBodyError: "generic",
    onParseError: "generic",
    decodeError: (e) =>
      e === "conversation-not-found"
        ? "conversationNotFound"
        : e === "unauthorized"
          ? "unauthorized"
          : e === "no-model"
            ? "no-model"
            : "generic",
    onEvent: (ev, ctx) => {
      switch (ev.type) {
        case "delta":
          textRef.current += ev.text
          setAssistantText(textRef.current)
          break
        case "rollback":
          // 主 Agent 工具步的思考文字已按 delta 累积进 assistantText，
          // 从尾部回滚（它不属于最终回答正文；工具过程对用户不可见）
          textRef.current = textRef.current.slice(
            0,
            Math.max(0, textRef.current.length - ev.chars)
          )
          setAssistantText(textRef.current)
          break
        case "a2ui":
          // 卡片消息串：done 前到达，暂存供流式期展示与 onDone 回传
          a2uiRef.current = ev.messages
          setA2uiMessages(ev.messages)
          onA2ui?.(ev.messages)
          break
        case "done": {
          const content = ev.content
          textRef.current = content ?? ""
          setAssistantText(content ?? "")
          ctx.markDone()
          onDone?.(content, ev.usage, a2uiRef.current)
          break
        }
        case "error":
          ctx.fail(ev.code)
          break
      }
    },
    onReset: () => {
      textRef.current = ""
      setAssistantText("")
      a2uiRef.current = null
      setA2uiMessages([])
    },
    onError,
  })

  return {
    state: {
      status: sse.status,
      assistantText,
      a2uiMessages,
      errorCode: sse.errorCode,
    },
    start: sse.start,
    cancel: sse.cancel,
    reset: sse.reset,
  }
}
