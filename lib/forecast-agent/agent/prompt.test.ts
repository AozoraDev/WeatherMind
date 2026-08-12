import { describe, expect, it } from "vitest"

import { METRICS, type PredictionResult } from "@/lib/schemas/forecast-agent"

import {
  buildReconcileMessages,
  buildRiskMessages,
  buildSupervisorMessages,
  formatMetricValue,
  type ForecastAgentCtx,
} from "./prompt"

// 提示词按语言输出：英文模式下指标表/风险行/分歧块必须全英文，
// 否则模型看到中文数据表会顺着输出中文（summary/points 语言跑偏）。
// 源快照已从提示词下放（只经 query_source 获取）；RESULT 中 openweather precip=1、
// 其余 0，恰触发降水分歧 → reconcile/supervisor 的 user 应出现「必须核对分歧源」的强制指令。
// 多 agent 拆分后：主管承担输出契约（## 推理过程/## 预报），reconcile/risk 只输出供引用的结论。

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

// 无分歧 fixture：全源无降水、全晴、温度接近 → 分歧块为空，但主管仍须委托两位专家（确定性）
const RESULT_FLAT: PredictionResult = {
  ...RESULT,
  sourceInputs: {
    "open-meteo": { ...RESULT.sourceInputs["open-meteo"], precip: 0 },
    openweather: { ...RESULT.sourceInputs.openweather, precip: 0 },
    weatherapi: { ...RESULT.sourceInputs.weatherapi, precip: 0 },
  },
}

// 无风险 fixture：risk_flags 为空 → 指标表风险行渲染「无风险标记」
const RESULT_NO_RISK: PredictionResult = { ...RESULT, riskFlags: [] }

const CITY = { nameJa: "東京", nameEn: "Tokyo" }

const ctx = (
  locale: "zh" | "en",
  result: PredictionResult = RESULT
): ForecastAgentCtx => ({ city: CITY, day: "2026-08-09", result, locale })

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

describe("buildSupervisorMessages", () => {
  it("中文：角色为统筹主管，硬性要求委托两位专家；含两段契约与完整数据段", () => {
    const [system, user] = buildSupervisorMessages(ctx("zh"))
    const full = `${system.content}\n${user.content}`
    expect(system.content).toContain("统筹主管")
    expect(system.content).toContain("delegate_reconcile")
    expect(system.content).toContain("delegate_risk")
    // 确定性委托：定稿前必须依次调用两位专家（否则无分歧时时间线只剩主管）
    expect(system.content).toContain("必须依次调用 delegate_reconcile 与 delegate_risk")
    // 数据段：指标表/权重/源/分歧块全部本地化
    expect(full).toContain("预测高温")
    expect(full).toContain("各源权重")
    expect(full).toContain("可查询的源（query_source）")
    expect(full).toContain("检测到各源数据分歧：降水 openweather 报有雨")
    // 输出契约：仅两段二级标题
    expect(user.content).toContain("## 推理过程")
    expect(user.content).toContain("## 预报")
    expect(system.content).toContain("简体中文")
  })

  it("英文：角色为 supervisor，委托两位专家；指标表/风险/分歧全英文，两段契约", () => {
    const [system, user] = buildSupervisorMessages(ctx("en"))
    const full = `${system.content}\n${user.content}`
    expect(system.content).toContain("supervisor")
    expect(system.content).toContain(
      "MUST call both delegate_reconcile and delegate_risk"
    )
    expect(full).toContain("Predicted high")
    expect(full).toContain("weighted ensemble mean")
    expect(full).toContain("Heat (warning): 2 source(s) agree")
    expect(full).toContain(
      "The sources disagree: precipitation: openweather report rain, open-meteo, weatherapi report no rain."
    )
    expect(full).toContain(
      "Call query_source to verify each diverging source's raw snapshot before finalizing."
    )
    expect(user.content).toContain("## Reasoning")
    expect(user.content).toContain("## Forecast")
    expect(system.content).toContain("never Chinese or Japanese")
    // 源快照下放：用户消息不再内联各源原始数据
    expect(full).not.toContain("Per-source input snapshot")
    expect(full).not.toContain("n/a")
    expect(full).not.toContain("预测高温")
  })

  it("无分歧时仍硬性要求委托两位专家（确定性委托），分歧块为空", () => {
    const [system, user] = buildSupervisorMessages(ctx("zh", RESULT_FLAT))
    expect(system.content).toContain("必须依次调用 delegate_reconcile 与 delegate_risk")
    expect(user.content).not.toContain("检测到各源数据分歧")
  })
})

describe("buildReconcileMessages", () => {
  it("中文：源核对专家角色、只读约束，user 含分歧块与源列表，无输出契约", () => {
    const [system, user] = buildReconcileMessages(ctx("zh"))
    const full = `${system.content}\n${user.content}`
    expect(system.content).toContain("源核对专家")
    expect(system.content).toContain("只读快照")
    expect(full).toContain("检测到各源数据分歧：降水 openweather 报有雨")
    expect(full).toContain("请先调用 query_source 逐一核对分歧源的原始快照后再定稿。")
    expect(full).toContain("可查询的源（query_source）")
    // reconcile 只输出结论供主管引用，不背最终文档契约
    expect(system.content).not.toContain("## 预报")
    expect(system.content).not.toContain("两位专家")
  })

  it("英文：source cross-check 角色、Read-only 约束，分歧块与源列表全英文", () => {
    const [system, user] = buildReconcileMessages(ctx("en"))
    const full = `${system.content}\n${user.content}`
    expect(system.content).toContain("source cross-check specialist")
    expect(system.content).toContain("Read-only")
    expect(full).toContain("The sources disagree")
    expect(full).toContain("Available sources for query_source")
    expect(system.content).not.toContain("## Forecast")
  })

  it("无分歧时 reconcile 的 user 不出现分歧块（任务层仍说明可直述无需核对）", () => {
    const [, user] = buildReconcileMessages(ctx("zh", RESULT_FLAT))
    expect(user.content).not.toContain("检测到各源数据分歧")
    expect(user.content).not.toContain("请先调用 query_source")
  })
})

describe("buildRiskMessages", () => {
  it("中文：风险解读专家角色，user 含指标表风险行，无源列表（无工具）", () => {
    const [system, user] = buildRiskMessages(ctx("zh"))
    const full = `${system.content}\n${user.content}`
    expect(system.content).toContain("风险解读专家")
    expect(system.content).toContain("绝不虚构或夸大")
    // 指标表风险行本地化：仅能依赖指标表，不得凭空捏造
    expect(user.content).toContain("高温（警告）：2 个数据源一致")
    // 无 query_source 工具：不给源列表、不给分歧块
    expect(full).not.toContain("可查询的源（query_source）")
    expect(full).not.toContain("query_source")
    // risk 不背输出契约、不委托
    expect(system.content).not.toContain("## 预报")
    expect(system.content).not.toContain("delegate_")
  })

  it("英文：risk review 角色，风险行全英文，无工具相关文案", () => {
    const [system, user] = buildRiskMessages(ctx("en"))
    const full = `${system.content}\n${user.content}`
    expect(system.content).toContain("risk interpretation specialist")
    expect(user.content).toContain("Heat (warning): 2 source(s) agree")
    expect(full).not.toContain("query_source")
    expect(full).not.toContain("delegate_")
  })

  it("无风险时指标表风险行渲染「无风险标记」，系统仍含不得虚构约束", () => {
    const [system, user] = buildRiskMessages(ctx("zh", RESULT_NO_RISK))
    expect(user.content).toContain("（无风险标记）")
    expect(system.content).toContain("绝不虚构或夸大")
  })
})
