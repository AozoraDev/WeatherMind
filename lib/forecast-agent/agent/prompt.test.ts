import { describe, expect, it } from "vitest"

import { METRICS, type PredictionResult } from "@/lib/schemas/forecast-agent"

import { buildForecastAgentMessages, formatMetricValue } from "./prompt"

// 提示词按语言输出：英文模式下指标表/风险行/分歧块必须全英文，
// 否则模型看到中文数据表会顺着输出中文（summary/points 语言跑偏）。
// 源快照已从提示词下放（只经 query_source 获取）；RESULT 中 openweather precip=1、
// 其余 0，恰触发降水分歧 → 用户消息应出现「必须核对分歧源」的强制指令。

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

// 条件分歧 fixture：全源无降水（不触发降水分歧）、温差小（不触发温差分歧），
// 仅 open-meteo 报晴 vs openweather 报雨 → 分歧块只剩条件一条
const RESULT_COND: PredictionResult = {
  ...RESULT,
  sourceInputs: {
    "open-meteo": { ...RESULT.sourceInputs["open-meteo"], precip: 0 },
    openweather: {
      ...RESULT.sourceInputs.openweather,
      precip: 0,
      condition: "rain",
    },
    weatherapi: { ...RESULT.sourceInputs.weatherapi, precip: 0 },
  },
}

// 温差分歧 fixture：全源无降水、条件全晴，仅高温 30~34 spread 4°C → 分歧块只剩高温一条
const RESULT_TEMP: PredictionResult = {
  ...RESULT,
  sourceInputs: {
    "open-meteo": { ...RESULT.sourceInputs["open-meteo"], high: 30, precip: 0 },
    openweather: {
      ...RESULT.sourceInputs.openweather,
      high: 34,
      precip: 0,
    },
    weatherapi: { ...RESULT.sourceInputs.weatherapi, high: 32, precip: 0 },
  },
}

const CITY = { nameJa: "東京", nameEn: "Tokyo" }

describe("formatMetricValue", () => {
  it("未知 metricId → 空串（不抛错兜底）", () => {
    expect(formatMetricValue("zh", RESULT, "not_a_metric")).toBe("")
  })

  it("数值型指标按口径格式化", () => {
    expect(formatMetricValue("zh", RESULT, METRICS.high)).toBe("33.5°C")
    expect(formatMetricValue("zh", RESULT, METRICS.poP)).toBe("10%")
    expect(formatMetricValue("zh", RESULT, METRICS.wind)).toBe("3 级")
  })
})

describe("buildForecastAgentMessages", () => {
  it("英文模式：指标表/风险行全英文，不含中文标签；降水分歧块注入强制核对指令", () => {
    const [system, user] = buildForecastAgentMessages(
      CITY,
      "2026-08-09",
      RESULT,
      "en"
    )
    const full = `${system.content}\n${user.content}`
    expect(full).toContain("Predicted high")
    expect(full).toContain("weighted ensemble mean")
    expect(full).toContain("Precipitation probability")
    expect(full).toContain("Heat (warning): 2 source(s) agree")
    // 源快照下放：用户消息不再内联各源原始数据
    expect(full).not.toContain("Per-source input snapshot")
    expect(full).not.toContain("n/a")
    // 降水分歧块：列出 wet/dry 源 + 强制 query_source 核对指令
    expect(full).toContain(
      "The sources disagree: precipitation: openweather report rain, open-meteo, weatherapi report no rain."
    )
    expect(full).toContain(
      "Call query_source to verify each diverging source's raw snapshot before finalizing."
    )
    expect(full).toContain("Available sources for query_source")
    // ReAct 协议：源快照仅经 query_source 获取（杀提示词 ReAct 文本突变）
    expect(system.content).toContain(
      "Per-source raw snapshots are NOT included in this prompt"
    )
    expect(system.content).toContain("query_source")
    expect(system.content).toContain("get_metric")
    expect(system.content).toContain("ReAct protocol")
    expect(full).not.toContain("预测高温")
    expect(full).not.toContain("加权集成均值")
  })

  it("中文模式：指标表/风险行中文；降水分歧块注入强制核对指令", () => {
    const [system, user] = buildForecastAgentMessages(
      CITY,
      "2026-08-09",
      RESULT,
      "zh"
    )
    const full = `${system.content}\n${user.content}`
    expect(full).toContain("预测高温")
    expect(full).toContain("加权集成均值")
    expect(full).toContain("高温（警告）：2 个数据源一致")
    expect(full).not.toContain("Per-source input snapshot")
    expect(full).not.toContain("n/a")
    // 降水分歧块（zh 分隔符：`、` 内嵌 + `，` 列表连接）
    expect(full).toContain(
      "检测到各源数据分歧：降水 openweather 报有雨、open-meteo，weatherapi 报无雨。"
    )
    expect(full).toContain("请先调用 query_source 逐一核对分歧源的原始快照后再定稿。")
    expect(full).toContain("可查询的源（query_source）")
    // ReAct 协议：源快照仅经 query_source 获取
    expect(system.content).toContain("各源的原始快照不会出现在本提示词中")
    expect(system.content).toContain("query_source")
    expect(system.content).toContain("get_metric")
    expect(system.content).toContain("ReAct 协议")
  })

  it("条件分歧渲染：clear vs rain 分组按条件序（晴在前），中英文一致", () => {
    const zh = buildForecastAgentMessages(CITY, "2026-08-09", RESULT_COND, "zh")
    expect(`${zh[0].content}\n${zh[1].content}`).toContain(
      "检测到各源数据分歧：天气状况 晴：open-meteo，雨：openweather。"
    )
    const en = buildForecastAgentMessages(CITY, "2026-08-09", RESULT_COND, "en")
    expect(`${en[0].content}\n${en[1].content}`).toContain(
      "The sources disagree: condition: Clear: open-meteo, Rain: openweather."
    )
  })

  it("温差分歧渲染：高温 spread 4°C，复用指标 label 作 metric 名，中英文一致", () => {
    const zh = buildForecastAgentMessages(CITY, "2026-08-09", RESULT_TEMP, "zh")
    expect(`${zh[0].content}\n${zh[1].content}`).toContain(
      "检测到各源数据分歧：预测高温 源间差距 4°C（30~34°C）。"
    )
    const en = buildForecastAgentMessages(CITY, "2026-08-09", RESULT_TEMP, "en")
    expect(`${en[0].content}\n${en[1].content}`).toContain(
      "The sources disagree: Predicted high spread 4°C across sources (30~34°C)."
    )
  })

  // 指标表条件类值本地化：condition/precipLevel/confidence 不再输出原始英文码，
  // 否则模型在中文表里看到英文码会顺着输出英文（与卡片演算展示口径一致）
  it("英文模式：指标表条件类值本地化（Clear/No rain/Medium），system 含语言指令", () => {
    const [system, user] = buildForecastAgentMessages(
      CITY,
      "2026-08-09",
      RESULT,
      "en"
    )
    const full = `${system.content}\n${user.content}`
    expect(full).toContain("condition (Condition): Clear")
    expect(full).toContain("precip_level (Precip level): No rain")
    expect(full).toContain("confidence (Confidence): Medium")
    // 不再出现原始英文码（防退化）
    expect(full).not.toContain("condition: clear")
    expect(full).not.toContain("confidence: medium")
    // 显式语言指令兜底：中文倾向模型也会被要求用英文输出
    expect(system.content).toContain("never Chinese or Japanese")
  })

  it("中文模式：指标表条件类值本地化（晴/无降水/中），system 含简体中文指令", () => {
    const [system, user] = buildForecastAgentMessages(
      CITY,
      "2026-08-09",
      RESULT,
      "zh"
    )
    const full = `${system.content}\n${user.content}`
    expect(full).toContain("condition（天气状况）：晴")
    expect(full).toContain("precip_level（降水等级）：无降水")
    expect(full).toContain("confidence（可信度）：中")
    expect(system.content).toContain("简体中文")
  })

  // —— 纯 Markdown 输出契约（新） ——
  // 输出文档固定两段：推理过程 + 预报。预报正文必须含温度（°C），
  // 旧「禁止温度单位」铁律已删除——断言新契约存在、旧禁令不残留
  it("中文：文档契约两段标题（## 推理过程 / ## 预报），预报段要求含 °C 温度", () => {
    const [system, user] = buildForecastAgentMessages(
      CITY,
      "2026-08-09",
      RESULT,
      "zh"
    )
    const full = `${system.content}\n${user.content}`
    expect(full).toContain("## 推理过程")
    expect(full).toContain("## 预报")
    // 预报段数值契约：高温/低温含 °C，降水概率含 %
    expect(full).toContain("预测高温与低温（含 °C）")
    expect(full).toContain("降水概率（%）")
    // 只输出一份 Markdown 文档，不得有 JSON/代码围栏
    expect(full).toContain("不要 JSON、不要代码围栏")
    // 旧禁令不残留（预报正文本就必须含温度数字）
    expect(full).not.toContain("温度单位")
    expect(full).not.toContain("不得出现温度")
  })

  it("英文：文档契约两段标题（## Reasoning / ## Forecast），预报段要求含 °C 温度", () => {
    const [system, user] = buildForecastAgentMessages(
      CITY,
      "2026-08-09",
      RESULT,
      "en"
    )
    const full = `${system.content}\n${user.content}`
    expect(full).toContain("## Reasoning")
    expect(full).toContain("## Forecast")
    // 预报段数值契约：高温/低温 with °C，降水概率 %
    expect(full).toContain("predicted high and low temperatures (with °C)")
    expect(full).toContain("precipitation probability (%)")
    // 只输出一份 Markdown 文档（单文档出口，system 里也声明）
    expect(full).toContain("exactly these two H2 sections")
    expect(system.content).toContain("output only ONE Markdown document")
    // 旧禁令不残留
    expect(full).not.toContain("temperature unit")
  })

  it("权重行只列三源、不泄漏 detail 明细（回归：曾输出 detail=[object Object]）", () => {
    // 构造带 detail 的 weights（模拟生产 computeWeights 的 Weights 返回值）
    const withDetail = {
      ...RESULT,
      weights: {
        "open-meteo": 0.5,
        openweather: 0.3,
        weatherapi: 0.2,
        detail: { alpha: 0.7, beta: 0.3, gamma: 0 },
      },
    } as unknown as PredictionResult
    const [system, user] = buildForecastAgentMessages(
      CITY,
      "2026-08-09",
      withDetail,
      "zh"
    )
    const full = `${system.content}\n${user.content}`
    expect(full).toContain("open-meteo=0.5")
    expect(full).not.toContain("detail")
    expect(full).not.toContain("[object Object]")
  })
})
