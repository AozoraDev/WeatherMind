import { z } from "zod"

// AI 模型配置 schema：错误 message 统一为 i18n key（dashboard.settings.modelConfig.errors.*）。
// connectionSchema 校验「测试链接」前置条件（地址合法 + key 非空），
// modelConfigSchema 在「确定」时再要求已选模型。

// 连接表单：URL 必填合法、API Key 必填非空
export const connectionSchema = z.object({
  baseUrl: z.url("invalidUrl"),
  apiKey: z.string().trim().min(1, "apiKeyRequired"),
})

// 完整配置表单：在连接基础上要求选择模型
export const modelConfigSchema = connectionSchema.extend({
  model: z.string().trim().min(1, "modelRequired"),
})

// OpenAI 兼容 /models 响应：data 必填数组、id 必填非空，其余字段可缺
export const modelsResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      object: z.string().optional(),
      owned_by: z.string().optional(),
    })
  ),
})

export type ConnectionValues = z.infer<typeof connectionSchema>
export type ModelConfigValues = z.infer<typeof modelConfigSchema>
