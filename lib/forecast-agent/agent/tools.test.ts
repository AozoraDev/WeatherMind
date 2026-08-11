import { describe, expect, it } from "vitest"

import { METRICS, type PredictionResult } from "@/lib/schemas/forecast-agent"

import { buildTools } from "./tools"

// 与 prompt.test.ts 同构的确定性内核结果：三个源都有快照
const RESULT: PredictionResult = {
  high: 33.5,
  low: 24,
  highInterval: [31.5, 35.5],
  lowInterval: [22, 26],
  poP: 10,
  precipLevel: "none",
  condition: "clear",
  windBeaufort: 3,
  windMs: 5.2,
  humidity: 65,
  confidence: "medium",
  riskFlags: [{ type: "heat", level: "warning", sources: 2 }],
  weights: { "open-meteo": 0.5, openweather: 0.3, weatherapi: 0.2 },
  sourceInputs: {
    "open-meteo": {
      source: "open-meteo",
      high: 33,
      low: 24,
      precip: 0,
      condition: "clear",
      humidity: 64,
      windMs: 5,
    },
    openweather: {
      source: "openweather",
      high: 34,
      low: 23,
      precip: 1,
      condition: "clear",
      humidity: 66,
      windMs: 5.4,
    },
    weatherapi: {
      source: "weatherapi",
      high: 33,
      low: 25,
      precip: 0,
      condition: null,
      humidity: null,
      windMs: null,
    },
  },
}

// 某源在快照里缺位（运行时可能发生的部分数据），模拟防御分支
const RESULT_MISSING_SOURCE = {
  ...RESULT,
  sourceInputs: {
    "open-meteo": RESULT.sourceInputs["open-meteo"],
    openweather: RESULT.sourceInputs.openweather,
  },
} as unknown as PredictionResult

describe("buildTools", () => {
  it("返回两个工具，顺序 query_source → get_metric", () => {
    const tools = buildTools({ result: RESULT, locale: "en" })
    expect(tools.map((t) => t.name)).toEqual(["query_source", "get_metric"])
  })

  it("参数枚举与 schema/METRICS 同源，防两处口径漂移", () => {
    const [querySource, getMetric] = buildTools({
      result: RESULT,
      locale: "en",
    })
    const sourceParams = querySource.parameters as {
      properties: { source: { enum?: string[] } }
    }
    // sources 枚举取自 sourceSchema（与 schemas/weather.ts 同序）
    expect(sourceParams.properties.source.enum).toEqual([
      "open-meteo",
      "openweather",
      "weatherapi",
    ])
    const metricParams = getMetric.parameters as {
      properties: { metricId: { enum?: string[] } }
    }
    // metricId 枚举取自 METRICS 常量
    expect(metricParams.properties.metricId.enum).toEqual([
      ...new Set(Object.values(METRICS)),
    ])
    expect(metricParams.properties.metricId.enum).toContain(METRICS.high)
  })

  it("参数 JSON-schema 逐字段完整（type/required/additionalProperties 与描述非空）", () => {
    const [querySource, getMetric] = buildTools({
      result: RESULT,
      locale: "en",
    })
    // 发往 API 的 schema 是模型选工具的契约，逐字段断言防静默漂移
    expect(querySource.parameters).toEqual({
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["open-meteo", "openweather", "weatherapi"],
        },
      },
      required: ["source"],
      additionalProperties: false,
    })
    expect(getMetric.parameters).toEqual({
      type: "object",
      properties: {
        metricId: {
          type: "string",
          enum: [...new Set(Object.values(METRICS))],
        },
      },
      required: ["metricId"],
      additionalProperties: false,
    })
    // 描述供模型理解用途，非空即可（精确文案易碎，不逐字断言）
    expect(querySource.description.length).toBeGreaterThan(0)
    expect(getMetric.description.length).toBeGreaterThan(0)
  })

  it("工具描述按 locale 本地化：en 无中文、zh 有中文（防模型被中文工具文档带偏输出）", () => {
    const [qsEn, gmEn] = buildTools({ result: RESULT, locale: "en" })
    expect(qsEn.description).not.toMatch(/[一-鿿]/)
    expect(gmEn.description).not.toMatch(/[一-鿿]/)
    const [qsZh, gmZh] = buildTools({ result: RESULT, locale: "zh" })
    expect(qsZh.description).toMatch(/[一-鿿]/)
    expect(gmZh.description).toMatch(/[一-鿿]/)
  })
})

describe("query_source", () => {
  const [querySource] = buildTools({ result: RESULT, locale: "en" })

  it("有效源 → 返回该源原始快照 JSON", () => {
    expect(querySource.execute({ source: "open-meteo" })).toBe(
      JSON.stringify(RESULT.sourceInputs["open-meteo"])
    )
  })

  it("非法源名 → 参数校验拒绝并提示合法取值", () => {
    const out = JSON.parse(querySource.execute({ source: "yahoo" })) as {
      error: string
    }
    // 精确断言错误文案，杀 separator 等文案突变
    expect(out.error).toBe(
      "invalid arguments: source must be one of open-meteo, openweather, weatherapi"
    )
  })

  it("源参数类型错误 → 拒绝", () => {
    const out = JSON.parse(querySource.execute({ source: 123 })) as {
      error: string
    }
    expect(out.error).toContain("invalid arguments")
  })

  it("数据缺位的源 → 返回 no data 错误而非崩溃", () => {
    const [qs] = buildTools({ result: RESULT_MISSING_SOURCE, locale: "en" })
    expect(qs.execute({ source: "weatherapi" })).toBe(
      '{"error":"no data for source: weatherapi"}'
    )
  })
})

describe("get_metric", () => {
  it("有效 id → 返回指标权威值（与提示词同一口径）", () => {
    const [, getMetric] = buildTools({ result: RESULT, locale: "en" })
    const out = JSON.parse(getMetric.execute({ metricId: METRICS.high })) as {
      metricId: string
      label: string
      value: string
      note: string
    }
    expect(out).toEqual({
      metricId: METRICS.high,
      label: "Predicted high",
      value: "33.5°C",
      note: "weighted ensemble mean",
    })
  })

  it("中文 locale → label/note 走中文文案", () => {
    const [, getMetric] = buildTools({ result: RESULT, locale: "zh" })
    const out = JSON.parse(getMetric.execute({ metricId: METRICS.wind })) as {
      label: string
      value: string
      note: string
    }
    expect(out.label).toBe("风力")
    expect(out.value).toBe("3 级")
    expect(out.note).toBe("加权风速换算蒲福风级")
  })

  it("未知 id → unknown metric 错误", () => {
    const [, getMetric] = buildTools({ result: RESULT, locale: "en" })
    expect(getMetric.execute({ metricId: "bogus" })).toBe(
      '{"error":"unknown metric: bogus"}'
    )
  })

  it("metricId 缺失或非字符串 → 拒为 unknown metric", () => {
    const [, getMetric] = buildTools({ result: RESULT, locale: "en" })
    // 非字符串时 id 取空串，仍走 unknown metric 拒绝分支
    expect(getMetric.execute({})).toBe('{"error":"unknown metric: "}')
    expect(getMetric.execute({ metricId: 42 })).toBe(
      '{"error":"unknown metric: "}'
    )
  })
})
