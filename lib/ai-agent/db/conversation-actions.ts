"use server"

import { createClient } from "@/supabase/server"
import { createServiceClient } from "@/supabase/service"
import {
  deleteConversationSchema,
  type DeleteConversationValues,
} from "@/lib/schemas/ai-agent"
import type { ConversationActionErrorCode } from "../common/errors"

export type ConversationActionResult =
  | { ok: true; id?: string }
  | { ok: false; error: ConversationActionErrorCode }

// 取当前登录用户 id；未登录返回 null（写库前必过，防绕过 UI 直调动作）
async function currentUserId(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user?.id ?? null
}

// 新建对话：只建空壳（空标题/空消息），消息与标题由 chat 路由在首轮对话时写入。
// 返回新会话 id 供前端跳转 ?id=<id>；失败归受限错误码，不抛错
export async function createConversationAction(): Promise<ConversationActionResult> {
  const userId = await currentUserId()
  if (!userId) return { ok: false, error: "unauthorized" }

  try {
    const { data, error } = await createServiceClient()
      .from("ai_conversations")
      .insert({ user_id: userId })
      .select("id")
      .single()
    if (error || !data?.id) return { ok: false, error: "generic" }
    return { ok: true, id: data.id }
  } catch {
    return { ok: false, error: "generic" }
  }
}

// 删除对话：schema 先验 → 登录 → service 硬删，并带 user_id 过滤（归属校验，防删他人会话）；
// 删 0 行（已被并发删掉或非本人）映射为 notFound
export async function deleteConversationAction(
  values: DeleteConversationValues
): Promise<ConversationActionResult> {
  const parsed = deleteConversationSchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }
  const userId = await currentUserId()
  if (!userId) return { ok: false, error: "unauthorized" }

  try {
    // .select("id") 返回被删行，用于区分「删了 0 行」→ notFound
    const { data, error } = await createServiceClient()
      .from("ai_conversations")
      .delete()
      .eq("id", parsed.data.id)
      .eq("user_id", userId)
      .select("id")
    if (error) return { ok: false, error: "generic" }
    if (!data || data.length === 0) return { ok: false, error: "notFound" }
    return { ok: true }
  } catch {
    return { ok: false, error: "generic" }
  }
}
