import { getLocale, getTranslations } from "next-intl/server"

import { AiAgentView } from "@/components/dashboard/ai-agent/ai-agent-view"
import { createClient } from "@/supabase/server"
import { redirect } from "@/i18n/navigation"
import {
  conversationMessagesSchema,
  type ConversationMessage,
  type ConversationRow,
} from "@/lib/schemas/ai-agent"

// AI 助手页：侧栏会话列表 + 右侧聊天区。
// 服务端取会话列表与当前会话的初始消息（RLS 自动按用户过滤），传给客户端组件；
// ?id= 标识当前会话：缺失/无效时重定向到首个会话的规范 URL（地址栏始终与选中一致）。
// 未配置模型的拦截在客户端（模型配置只存 localStorage），见 AiAgentView。
export default async function AiAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>
}) {
  const t = await getTranslations("dashboard.aiAgent")
  const { id: rawId } = await searchParams
  const supabase = await createClient()

  const [convRes, userRes] = await Promise.all([
    supabase
      .from("ai_conversations")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false }),
    supabase.auth.getUser(),
  ])

  const conversations = (convRes.data ?? []) as ConversationRow[]
  const email = userRes.data.user?.email ?? ""

  // 解析 ?id=：有会话且 id 缺失/无效时补齐重定向（照 resolve-city 模式）；无会话则不跳
  let currentConversationId: string | null = null
  if (conversations.length > 0) {
    const selected = conversations.some((c) => c.id === rawId)
      ? rawId!
      : conversations[0].id
    if (selected !== rawId) {
      redirect({
        href: { pathname: "/dashboard/ai-agent", query: { id: selected } },
        locale: await getLocale(),
      })
    }
    currentConversationId = selected
  }

  // 当前会话的消息作为初始状态；jsonb 在信任边界 safeParse 兜底，异常视为空
  let initialMessages: ConversationMessage[] = []
  if (currentConversationId) {
    const msgRes = await supabase
      .from("ai_conversations")
      .select("messages")
      .eq("id", currentConversationId)
      .single()
    const parsed = conversationMessagesSchema.safeParse(msgRes.data?.messages)
    if (parsed.success) initialMessages = parsed.data
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>
      </div>
      <AiAgentView
        conversations={conversations}
        currentConversationId={currentConversationId}
        initialMessages={initialMessages}
        email={email}
      />
    </div>
  )
}
