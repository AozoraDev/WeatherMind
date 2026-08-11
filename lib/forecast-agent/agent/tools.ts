import { z } from "zod"

import {
  METRICS,
  isMetricId,
  type PredictionResult,
} from "@/lib/schemas/forecast-agent"
import { sourceSchema } from "@/lib/schemas/weather"

import { formatMetricValue, metricMeta } from "./prompt"
import type { ReactTool } from "./react"

// ReAct 工具注册表：模型核对源数据/平台指标的唯一入口。
// 两个工具都只回读确定性内核算出的数据，绝不引入新计算或新数据（AI 不得自行推演数值）。
// 参数校验：发往 API 的 JSON-schema（parameters）与 execute 内的 zod 校验器并置同形，
// 防止模型给出非法参数时 execute 读到脏数据（工具参数属不可信输入，见 rules/zod-usage.md）

// 工具描述按语言：模型在 en 模式看到中文工具文档会被带偏输出中文，故 description 必须跟随 locale
const TOOL_DESCRIPTIONS: Record<
  "zh" | "en",
  { querySource: string; getMetric: string }
> = {
  zh: {
    querySource:
      "查询指定数据源的原始预报快照（高温/低温/降水/条件/湿度/风），用于核对某条指标的来源依据。",
    getMetric:
      "查询平台指标的权威值（含单位与口径说明），引用指标前可复核精确数值；metricId 需来自指标表。",
  },
  en: {
    querySource:
      "Query one data source's raw forecast snapshot (high/low/precip/condition/humidity/wind) to verify the basis of a metric.",
    getMetric:
      "Query the authoritative value of a platform metric (with units and definition); re-check exact numbers before citing; metricId must come from the metric table.",
  },
}

export function buildTools(params: {
  result: PredictionResult
  locale: "zh" | "en"
}): ReactTool[] {
  const { result, locale } = params
  const meta = metricMeta(locale)
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
    {
      name: "get_metric",
      description: desc.getMetric,
      parameters: {
        type: "object",
        // metricId 枚举取自 METRICS 常量（单一来源），防模型编造不存在的指标
        properties: {
          metricId: {
            type: "string",
            enum: [...new Set(Object.values(METRICS))],
          },
        },
        required: ["metricId"],
        additionalProperties: false,
      },
      execute: (args) => {
        const id = typeof args.metricId === "string" ? args.metricId : ""
        // 只放行指标表里的合法 id，防模型编造不存在的指标
        if (!isMetricId(id))
          return JSON.stringify({ error: `unknown metric: ${id}` })
        return JSON.stringify({
          metricId: id,
          label: meta[id]?.label ?? id,
          value: formatMetricValue(locale, result, id),
          note: meta[id]?.note ?? "",
        })
      },
    },
  ]
}
