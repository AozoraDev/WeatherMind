import { describe, expect, it } from "vitest"

import type { PredictionResult } from "@/lib/schemas/forecast-agent"

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
  it("返回单个工具 query_source", () => {
    const tools = buildTools({ result: RESULT, locale: "en" })
    expect(tools.map((t) => t.name)).toEqual(["query_source"])
  })

  it("参数枚举与 sourceSchema 同源，防两处口径漂移", () => {
    const [querySource] = buildTools({
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
  })

  it("参数 JSON-schema 逐字段完整（type/required/additionalProperties 与描述非空）", () => {
    const [querySource] = buildTools({
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
    // 描述供模型理解用途，非空即可（精确文案易碎，不逐字断言）
    expect(querySource.description.length).toBeGreaterThan(0)
  })

  it("工具描述按 locale 本地化：en 无中文、zh 有中文（防模型被中文工具文档带偏输出）", () => {
    const [qsEn] = buildTools({ result: RESULT, locale: "en" })
    expect(qsEn.description).not.toMatch(/[一-鿿]/)
    const [qsZh] = buildTools({ result: RESULT, locale: "zh" })
    expect(qsZh.description).toMatch(/[一-鿿]/)
  })
})

describe("query_source", () => {
  const [querySource] = buildTools({ result: RESULT, locale: "en" })

  it("有效源 → 返回该源原始快照 JSON", async () => {
    expect(await querySource.execute({ source: "open-meteo" })).toBe(
      JSON.stringify(RESULT.sourceInputs["open-meteo"])
    )
  })

  it("非法源名 → 参数校验拒绝并提示合法取值", async () => {
    const out = JSON.parse(await querySource.execute({ source: "yahoo" })) as {
      error: string
    }
    // 精确断言错误文案，杀 separator 等文案突变
    expect(out.error).toBe(
      "invalid arguments: source must be one of open-meteo, openweather, weatherapi"
    )
  })

  it("源参数类型错误 → 拒绝", async () => {
    const out = JSON.parse(await querySource.execute({ source: 123 })) as {
      error: string
    }
    expect(out.error).toContain("invalid arguments")
  })

  it("数据缺位的源 → 返回 no data 错误而非崩溃", async () => {
    const [qs] = buildTools({ result: RESULT_MISSING_SOURCE, locale: "en" })
    expect(await qs.execute({ source: "weatherapi" })).toBe(
      '{"error":"no data for source: weatherapi"}'
    )
  })
})
