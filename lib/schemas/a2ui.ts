import { z } from "zod"

// A2UI v0.9 消息信封的信任边界 schema（与 @a2ui/web_core/v0_9 协议对齐）：
// - 服务端模板化生成的卡片消息经此校验后落库/经 SSE 下发；消息从 DB 读回时也走 safeParse 兜底
// - 组件 props 只收紧 id/component，其余随组件类型透传——具体 prop 合法性由客户端渲染器运行时校验，
//   本 schema 只保证结构完整、可被前端 MessageProcessor 接受
// - BASIC_CATALOG_ID 是 @a2ui/react basicCatalog 的 catalogId（服务端不 import React，硬编码常量；
//   与 node_modules/@a2ui/react 中 basicCatalog.id 一致）

export const BASIC_CATALOG_ID =
  "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"

// 扁平组件列表项：id 唯一供父组件引用，component 为 catalog 中的组件名，其余 prop 随组件类型而变
export const a2uiComponentSchema = z
  .object({
    id: z.string().min(1),
    component: z.string().min(1),
  })
  .passthrough()

export type A2uiComponent = z.infer<typeof a2uiComponentSchema>

// 各消息类型：只收紧协议必需的字段，额外字段透传（渲染器自校验 prop）。
// 注：catalog 组件 schema（MetricTile 等）在 lib/schemas/a2ui-catalog.ts，须与 web_core 运行时
// 同源的 zod v3，本文件只保留与运行库无关的消息信封 schema（v4 zod）。
const createSurfacePayloadSchema = z
  .object({
    surfaceId: z.string().min(1),
    catalogId: z.string().min(1),
  })
  .passthrough()

const updateComponentsPayloadSchema = z
  .object({
    surfaceId: z.string().min(1),
    components: z.array(a2uiComponentSchema).min(1),
  })
  .passthrough()

const updateDataModelPayloadSchema = z
  .object({
    surfaceId: z.string().min(1),
    path: z.string(),
    value: z.unknown(),
  })
  .passthrough()

const deleteSurfacePayloadSchema = z
  .object({ surfaceId: z.string().min(1) })
  .passthrough()

export const a2uiMessageSchema = z.union([
  z.object({
    version: z.literal("v0.9"),
    createSurface: createSurfacePayloadSchema,
  }),
  z.object({
    version: z.literal("v0.9"),
    updateComponents: updateComponentsPayloadSchema,
  }),
  z.object({
    version: z.literal("v0.9"),
    updateDataModel: updateDataModelPayloadSchema,
  }),
  z.object({
    version: z.literal("v0.9"),
    deleteSurface: deleteSurfacePayloadSchema,
  }),
])

export type A2uiMessage = z.infer<typeof a2uiMessageSchema>

// 一张卡片 = 一串 v0.9 消息（createSurface → updateComponents → updateDataModel）
export const a2uiMessagesSchema = z.array(a2uiMessageSchema)

export type A2uiMessages = z.infer<typeof a2uiMessagesSchema>
