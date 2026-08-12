"use client"

import { Send } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useEffect, useRef, useState } from "react"

import { MessageBubble } from "@/components/dashboard/ai-agent/message-bubble"
import { ButtonGreen } from "@/components/ui-preset/button"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "@/i18n/navigation"
import { useChatStream, type ChatStreamErrorCode } from "@/hooks/use-chat-stream"
import type { ConversationMessage } from "@/lib/schemas/ai-agent"
import type { ModelConfig } from "@/lib/model-config"

// 错误码 → i18n key：ProviderErrorCode 用连字符（invalid-url），本项目的键用驼峰，需显式映射
const ERROR_KEY_MAP: Record<ChatStreamErrorCode, string> = {
  "invalid-url": "invalidUrl",
  blocked: "blocked",
  network: "network",
  http: "http",
  parse: "parse",
  unauthorized: "unauthorized",
  "no-model": "noModel",
  conversationNotFound: "conversationNotFound",
  generic: "generic",
}

// 右侧聊天区：按 conversationId 键控（父组件 key 变化即重挂载），本地持有消息列表/草稿/流式状态。
// 发送 = 乐观追加用户消息 + useChatStream 流式回复；done 后追加 assistant 消息并 router.refresh()
// 重拉服务端（刷新侧栏排序），本地消息与库内一致、无需再同步。
export function ChatPanel({
  conversationId,
  initialMessages,
  model,
}: {
  conversationId: string
  initialMessages: ConversationMessage[]
  model: ModelConfig | null
}) {
  const t = useTranslations("dashboard.aiAgent")
  const locale = useLocale() as "zh" | "en"
  const router = useRouter()
  const [messages, setMessages] =
    useState<ConversationMessage[]>(initialMessages)
  const [draft, setDraft] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  const stream = useChatStream({
    model,
    locale,
    onDone: (content, usage, a2ui) => {
      // 流式回复完成：追加 assistant 消息（空回复不追加），并重拉服务端同步侧栏排序。
      // usage（本次 token 消耗）随消息携带，气泡下方据此显示页脚；a2ui 卡片消息串
      // 一并携带（刷新后服务端读回仍可渲染卡片）
      if (content) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content,
            created_at: new Date().toISOString(),
            usage: usage ?? undefined,
            a2ui: a2ui ?? undefined,
          },
        ])
      }
      router.refresh()
    },
    onError: (code) => {
      // 会话被别处删除：重拉列表，由服务端 resolve 跳到有效会话
      if (code === "conversationNotFound") router.refresh()
    },
  })

  const { status, assistantText, a2uiMessages, errorCode } = stream.state
  const streaming = status === "streaming"
  const canSend = !streaming && draft.trim().length > 0

  // 新消息/流式增量到来时滚动到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, assistantText, status])

  const handleSend = () => {
    const text = draft.trim()
    if (!canSend) return
    // 乐观追加用户消息，随后开始流式请求
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, created_at: new Date().toISOString() },
    ])
    setDraft("")
    stream.start({ conversationId, content: text })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {messages.length === 0 && status === "idle" && (
            <p className="pt-16 text-center text-sm text-muted-foreground">
              {t("chat.empty")}
            </p>
          )}

          {messages.map((m, i) => (
            <MessageBubble key={`${m.created_at}-${i}`} message={m} />
          ))}

          {/* 流式期：临时 assistant 气泡承载已累积增量；a2ui 卡片到达即随气泡展示 */}
          {streaming && (
            <MessageBubble
              message={{
                role: "assistant",
                content: assistantText,
                created_at: "",
                a2ui: a2uiMessages.length > 0 ? a2uiMessages : undefined,
              }}
              streaming
            />
          )}

          {/* 错误态：错误文案 + 半成品灰显（有增量时） */}
          {status === "error" && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-destructive">
                {t("chat.errorBanner")}：
                {t(`errors.${ERROR_KEY_MAP[errorCode ?? "generic"]}`)}
              </p>
              {assistantText && (
                <div className="opacity-60">
                  <MessageBubble
                    message={{
                      role: "assistant",
                      content: assistantText,
                      created_at: "",
                      a2ui: a2uiMessages.length > 0 ? a2uiMessages : undefined,
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/60 p-4">
        <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.placeholder")}
            className="max-h-40 min-h-10 resize-none"
            rows={1}
            aria-label={t("chat.placeholder")}
          />
          <ButtonGreen className="shrink-0" disabled={!canSend} onClick={handleSend}>
            <Send aria-hidden="true" />
            {streaming ? t("chat.sending") : t("chat.send")}
          </ButtonGreen>
        </div>
      </div>
    </div>
  )
}
