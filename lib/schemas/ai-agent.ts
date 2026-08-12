import { z } from "zod"

import { modelConfigSchema } from "@/lib/schemas/ai"
import { chatUsageSchema } from "@/lib/schemas/agent-core"
import { a2uiMessageSchema } from "@/lib/schemas/a2ui"

// AI 助手（ai_conversations 表）的信任边界 schema：
// - conversationMessageSchema 校验 DB 读回的 jsonb 消息（chat 路由与页面初始数据边界）
// - chatRequestBodySchema 校验 /api/ai-agent/chat 请求体（外部不可信输入）
// - deleteConversationSchema 校验删除动作入参
// 错误 message 沿用 i18n key 风格（本项目约定，见 city.ts）。

// 单条对话消息：DB 里只存 user/assistant 两类，content 为纯文本（前端展示时再渲染 Markdown）；
// usage 为 assistant 消息可选的 token 消耗（provider 缺省时不写字段，旧消息兼容），前端据此显示气泡下页脚；
// a2ui 为 assistant 消息可选的 A2UI 卡片消息串（服务端由权威工具数据模板化生成，jsonb 存储，
// 旧消息无此字段仍兼容），刷新后客户端据此重新渲染卡片
export const conversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  created_at: z.string(),
  usage: chatUsageSchema.optional(),
  a2ui: z.array(a2uiMessageSchema).optional(),
})

export const conversationMessagesSchema = z.array(conversationMessageSchema)

export type ConversationMessage = z.infer<typeof conversationMessageSchema>

// chat 请求体：只带新的一条用户消息与当前界面语言，服务端以库内 messages 为权威历史
// （见 app/api/ai-agent/chat/route.ts，避免客户端历史与服务端漂移；locale 用于组织系统提示词，
// /api 不走 next-intl 中间件，服务端取不到语言，只能由客户端显式传入）
export const chatRequestBodySchema = z.object({
  conversationId: z.uuid("invalidInput"),
  content: z.string().trim().min(1, "emptyMessage"),
  locale: z.enum(["zh", "en"]),
  model: modelConfigSchema,
})

export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>

// 删除对话入参：仅接受合法 uuid
export const deleteConversationSchema = z.object({
  id: z.uuid("invalidInput"),
})

export type DeleteConversationValues = z.infer<typeof deleteConversationSchema>

// 侧栏会话列表行（snake_case，对应 0013 表结构；页面 RSC 读取后作为 props 传给客户端）
export type ConversationRow = {
  id: string
  title: string
  updated_at: string
}
