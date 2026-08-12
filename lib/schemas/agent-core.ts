import { z } from "zod"

// agent-core（lib/agent-core，OpenAI 兼容 chat + ReAct 通用原语）的信任边界 schema：
// - chatUsageSchema / chatResponseSchema 是外部 AI 响应（运行时 Zod 校验）
// - 与预报领域的 forecast-agent schema 分离，供两个 Agent 与前端 hook/路由共用

// —— OpenAI 兼容 chat 响应（不可信） ——
// usage 是 OpenAI 兼容接口的标准计费字段（prompt/completion/total），
// 部分代理缺省，故整块可选；缺省时卡片该行显示 — 而非报错
export const chatUsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
})

export type ChatUsage = z.infer<typeof chatUsageSchema>

export const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              })
            )
            .optional(),
        }),
      })
    )
    .min(1),
  usage: chatUsageSchema.optional(),
})
