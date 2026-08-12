"use client"

import { useTranslations } from "next-intl"
import { useEffect, useRef, useSyncExternalStore } from "react"

import { ChatPanel } from "@/components/dashboard/ai-agent/chat-panel"
import { ConversationList } from "@/components/dashboard/ai-agent/conversation-list"
import { useRouter } from "@/i18n/navigation"
import { useModelConfig } from "@/hooks/use-model-config"
import type {
  ConversationMessage,
  ConversationRow,
} from "@/lib/schemas/ai-agent"

// 已挂载检测：SSR 与首次客户端渲染（hydration）返回 false，挂载后返回 true。
// 用 useSyncExternalStore 同步快照替代 setState-in-effect（lint 禁同步 setState）。
// 与 useModelConfig 同一次提交后一起更新，保证 hydrated=true 时 modelConfig 已是客户端真实值
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
}

// AI 助手页主视图：左侧会话栏 + 右侧聊天区。
// 未配置 AI 模型（localStorage 无配置）时重定向到独立提示页——模型配置只有客户端能读，
// 故拦截在客户端做；SSR 恒 null，mounted 后才判定，防首屏闪跳。
// 聊天区按 currentConversationId 键控，切换会话即重挂载（消息/草稿/流自动重置）。
export function AiAgentView({
  conversations,
  currentConversationId,
  initialMessages,
  email,
}: {
  conversations: ConversationRow[]
  currentConversationId: string | null
  initialMessages: ConversationMessage[]
  email: string
}) {
  const t = useTranslations("dashboard.aiAgent")
  const router = useRouter()
  const modelConfig = useModelConfig(email)
  const hydrated = useHydrated()
  const redirectedRef = useRef(false)

  // 未配置模型 → 跳转提示页；redirectedRef 保证只跳一次。
  // hydrated 后才判定（SSR/hydration 期间 modelConfig 恒 null，防首屏误跳）
  useEffect(() => {
    if (hydrated && !modelConfig && !redirectedRef.current) {
      redirectedRef.current = true
      router.replace("/dashboard/ai-agent/setup")
    }
  }, [hydrated, modelConfig, router])

  // 首屏未挂载或未配置模型（跳转前）渲染骨架，避免闪出聊天界面
  if (!hydrated || !modelConfig) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <ConversationList
        conversations={conversations}
        activeId={currentConversationId}
      />
      {currentConversationId ? (
        <ChatPanel
          key={currentConversationId}
          conversationId={currentConversationId}
          initialMessages={initialMessages}
          model={modelConfig}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="max-w-sm text-center text-sm leading-6 text-muted-foreground">
            {t("conversations.empty")}
          </p>
        </div>
      )}
    </div>
  )
}
