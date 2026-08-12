"use client"

import { useMutation } from "@tanstack/react-query"
import { MessageSquare, Plus, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"

import { ButtonGreen } from "@/components/ui-preset/button"
import { useToast } from "@/components/ui-preset/toast"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useRouter } from "@/i18n/navigation"
import { createConversationAction, deleteConversationAction } from "@/lib/ai-agent/db/conversation-actions"
import {
  ConversationActionError,
  type ConversationActionErrorCode,
} from "@/lib/ai-agent/common/errors"
import type { ConversationRow } from "@/lib/schemas/ai-agent"
import { cn } from "@/lib/utils"

// action 错误码 → i18n key（invalidInput 走兜底 generic，unauthorized/notFound 有专属文案）
function actionErrorKey(code: ConversationActionErrorCode): string {
  if (code === "unauthorized") return "unauthorized"
  if (code === "notFound") return "conversationNotFound"
  return "generic"
}

// 左侧会话栏：新建对话 + 会话列表（当前项高亮）+ 悬停删除（确认弹窗）。
// 新建/删除成功都 router.refresh() 重拉服务端列表，新建再跳转到新会话 ?id=
export function ConversationList({
  conversations,
  activeId,
}: {
  conversations: ConversationRow[]
  activeId: string | null
}) {
  const t = useTranslations("dashboard.aiAgent")
  const router = useRouter()
  const toast = useToast()
  const [deleteTarget, setDeleteTarget] = useState<ConversationRow | null>(null)

  // 新建对话：插空行拿 id 后跳转，由服务端 resolve 把地址栏同步到 ?id=<新id>
  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await createConversationAction()
      if (!res.ok) throw new ConversationActionError(res.error)
      return res.id
    },
    onSuccess: (id) => {
      router.refresh()
      if (id) {
        router.push({ pathname: "/dashboard/ai-agent", query: { id } })
      }
    },
    onError: (e) => {
      toast.error(
        t(
          `errors.${
            e instanceof ConversationActionError
              ? actionErrorKey(e.code)
              : "generic"
          }`
        )
      )
    },
  })

  // 删除对话：确认后硬删；当前项被删时由服务端 resolve 自动跳到剩余首个会话
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await deleteConversationAction({ id })
      if (!res.ok) throw new ConversationActionError(res.error)
    },
    onSuccess: () => {
      setDeleteTarget(null)
      router.refresh()
    },
    onError: (e) => {
      setDeleteTarget(null)
      toast.error(
        t(
          `errors.${
            e instanceof ConversationActionError
              ? actionErrorKey(e.code)
              : "generic"
          }`
        )
      )
    },
  })

  return (
    <div className="flex h-full w-60 shrink-0 flex-col gap-2 border-r border-border/60 p-3">
      <ButtonGreen
        size="sm"
        className="w-full justify-center"
        disabled={createMutation.isPending}
        onClick={() => createMutation.mutate()}
      >
        <Plus aria-hidden="true" />
        {createMutation.isPending ? t("chat.sending") : t("conversations.new")}
      </ButtonGreen>

      {conversations.length === 0 ? (
        <p className="px-2 py-6 text-center text-xs leading-5 text-muted-foreground">
          {t("conversations.empty")}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          {conversations.map((convo) => {
            const active = convo.id === activeId
            return (
              <li
                key={convo.id}
                className={cn(
                  "group flex items-center gap-1 rounded-lg px-1 transition-colors",
                  active ? "bg-muted" : "hover:bg-muted/50"
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left"
                  onClick={() =>
                    router.push(
                      {
                        pathname: "/dashboard/ai-agent",
                        query: { id: convo.id },
                      },
                      { scroll: false }
                    )
                  }
                >
                  <MessageSquare
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span
                    className={cn(
                      "truncate text-sm",
                      active ? "font-medium text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {convo.title || t("conversations.defaultTitle")}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t("conversations.delete")}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  onClick={() => setDeleteTarget(convo)}
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("conversations.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("conversations.deleteConfirm")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={() => setDeleteTarget(null)}
            >
              {t("conversations.cancel")}
            </button>
            <ButtonGreen
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending
                ? t("conversations.deleting")
                : t("conversations.delete")}
            </ButtonGreen>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
