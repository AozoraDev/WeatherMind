"use client"

import { useLocale, useTranslations } from "next-intl"

import { Markdown } from "@/components/ui-preset/markdown"
import { A2uiCard } from "@/components/dashboard/ai-agent/a2ui-card"
import type { ConversationMessage } from "@/lib/schemas/ai-agent"

// 单条对话消息气泡：user 右对齐主色气泡（纯文本），assistant 左对齐卡片 + Markdown 渲染。
// streaming 用于流式期的临时气泡：content 为已累积增量，为空时显示「思考中」占位。
// assistant 消息带 usage（本次 token 消耗）时在内容下方渲染小字页脚（持久化自 DB，刷新仍显示）；
// 带 a2ui（服务端生成的卡片消息串）时在 markdown 下方渲染原生卡片（持久化自 DB，刷新仍显示）
export function MessageBubble({
  message,
  streaming,
}: {
  message: ConversationMessage
  streaming?: boolean
}) {
  const t = useTranslations("dashboard.aiAgent")
  const locale = useLocale()
  // 英文界面用 ASCII 冒号、中文用全角（与预报卡片 footer 口径一致）
  const sep = locale === "en" ? ": " : "："

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-xl bg-primary px-3.5 py-2 text-sm leading-6 text-primary-foreground">
          {message.content}
        </div>
      </div>
    )
  }

  const usage = message.usage

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-xl border border-border/60 bg-muted/40 px-3.5 py-2">
        <div className="flex flex-col gap-1.5">
          {message.content ? (
            <Markdown>{message.content}</Markdown>
          ) : streaming ? (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
              <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
            </span>
          ) : null}
          {/* 服务端生成的 a2ui 卡片：有卡片消息串才渲染 */}
          {message.a2ui && message.a2ui.length > 0 && (
            <A2uiCard messages={message.a2ui} />
          )}
          {/* 本次请求 token 消耗：只有 provider 回传 usage 才显示 */}
          {!streaming && usage && (
            <footer className="flex items-center gap-1 border-t border-border/60 pt-1.5 text-xs text-muted-foreground">
              {t("chat.tokensLabel")}
              {sep}
              <span className="text-foreground">
                {usage.prompt_tokens + usage.completion_tokens}
                <span className="text-muted-foreground">
                  {t("chat.tokensInOut", {
                    prompt: usage.prompt_tokens,
                    output: usage.completion_tokens,
                  })}
                </span>
              </span>
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}
