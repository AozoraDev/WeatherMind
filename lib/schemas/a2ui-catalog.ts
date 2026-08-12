import { z } from "zod-v3"
import { DynamicStringSchema } from "@a2ui/web_core/v0_9"

// 自定义 a2ui catalog 组件的信任边界 schema（与 lib/schemas/a2ui.ts 的消息信封 schema 分离）：
// 信封 schema 是我们自己的 v4 zod（serialize/反序列化用），本文件的组件 schema 直接喂给
// @a2ui/web_core 的 MessageProcessor/GenericBinder，必须与其运行时同源——web_core 固定依赖
// zod ^3.25.76（见其 package.json），而 binder 靠 `_def.typeName` 字符串匹配识别动态字符串、
// 校验失败靠 `error.errors` 取路径，这两点 v4 zod 都没有（v4 改用 `_zod` 符号、错误只有 issues）。
// 故这里用 npm 别名 zod-v3 指向同一版 zod 3.25.76，确保类型与运行时都与 web_core 对齐。
// value/sub 直接复用 web_core 导出的 DynamicStringSchema（{path} 绑定 + {call} 函数调用 + 字面量），
// 免去手工对齐漂移；icon/chip 为客户端 a2ui-catalog 映射到 lucide 图标 + 配色的语义键。

// MetricTile：预报指标磁贴（彩色图标块 + 标签 + 数值/说明）。label 静态文案，value/sub 走 data
// model path 绑定；.strict() 拒绝未知字段，服务端模板（forecast-card.ts）发出的消息必须与之一致。
export const metricTileSchema = z
  .object({
    icon: z.string().min(1),
    chip: z.string().min(1),
    label: z.string().min(1),
    value: DynamicStringSchema,
    sub: DynamicStringSchema.optional(),
  })
  .strict()

export type MetricTileProps = z.infer<typeof metricTileSchema>
