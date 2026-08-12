import { z } from "zod"

import type { PredictionResult } from "@/lib/schemas/forecast-agent"
import { sourceSchema } from "@/lib/schemas/weather"

import type { ReactTool } from "@/lib/agent-core/react"

// ReAct 工具注册表：模型核对源原始快照的唯一入口。
// 工具只回读确定性内核算出的数据，绝不引入新计算或新数据（AI 不得自行推演数值）。
// get_metric 已随提示词精简移除——user 消息的指标表已含全部权威值+注释，原样再查一遍纯属重复。
// 参数校验：发往 API 的 JSON-schema（parameters）与 execute 内的 zod 校验器并置同形，
// 防止模型给出非法参数时 execute 读到脏数据（工具参数属不可信输入，见 rules/zod-usage.md）

// 工具描述按语言：模型在 en 模式看到中文工具文档会被带偏输出中文，故 description 必须跟随 locale
const TOOL_DESCRIPTIONS: Record<"zh" | "en", { querySource: string }> = {
  zh: {
    querySource:
      "查询指定数据源的原始预报快照（高温/低温/降水/条件/湿度/风），用于核对某条指标的来源依据。",
  },
  en: {
    querySource:
      "Query one data source's raw forecast snapshot (high/low/precip/condition/humidity/wind) to verify the basis of a metric.",
  },
}

export function buildTools(params: {
  result: PredictionResult
  locale: "zh" | "en"
}): ReactTool[] {
  const { result, locale } = params
  const desc = TOOL_DESCRIPTIONS[locale]

  return [
    {
      name: "query_source",
      description: desc.querySource,
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: [...sourceSchema.options] },
        },
        required: ["source"],
        additionalProperties: false,
      },
      execute: (args) => {
        const parsed = z.object({ source: sourceSchema }).safeParse(args)
        if (!parsed.success) {
          return JSON.stringify({
            error: `invalid arguments: source must be one of ${sourceSchema.options.join(", ")}`,
          })
        }
        const snap = result.sourceInputs[parsed.data.source]
        // 源在权重/快照里可能缺位（数据不足），防御性返回错误而非崩溃
        if (!snap)
          return JSON.stringify({
            error: `no data for source: ${parsed.data.source}`,
          })
        return JSON.stringify(snap)
      },
    },
  ]
}
