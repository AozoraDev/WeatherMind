import { describe, expect, it } from "vitest"

import type { PredictionResult } from "@/lib/schemas/forecast-agent"

import {
  buildReconcileSpecialist,
  buildRiskSpecialist,
  buildSupervisorConfig,
  RECONCILE_AGENT_ID,
  RISK_AGENT_ID,
  SUPERVISOR_AGENT_ID,
} from "./specialists"
import type { ForecastAgentCtx } from "./prompt"

// 专家团注册：编排层的通用「主管+专家」由 specialists.ts 组装成预报领域的三位 agent。
// 断言各 agent 的 agentId/工具/提示词/委托描述正确，且委托描述随语言（en 必须英文）

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

const ctx = (locale: "zh" | "en"): ForecastAgentCtx => ({
  city: { nameJa: "東京", nameEn: "Tokyo" },
  day: "2026-08-09",
  result: RESULT,
  locale,
})

describe("buildReconcileSpecialist", () => {
  it("agentId=reconcile，工具为 query_source（源核对专家只读入口），maxSteps=3", () => {
    const spec = buildReconcileSpecialist(ctx("zh"))
    expect(spec.agentId).toBe(RECONCILE_AGENT_ID)
    const tools = spec.buildTools(ctx("zh"))
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("query_source")
    expect(spec.maxSteps).toBe(3)
    // 提示词确实是源核对专家
    const msgs = spec.buildMessages(ctx("zh"))
    expect(msgs[0].content).toContain("源核对专家")
  })

  it("委托描述随语言：en 为英文、zh 为中文", () => {
    expect(buildReconcileSpecialist(ctx("zh")).toolDescription(ctx("zh"))).toContain(
      "源核对专家"
    )
    expect(buildReconcileSpecialist(ctx("en")).toolDescription(ctx("en"))).toContain(
      "source cross-check"
    )
  })
})

describe("buildRiskSpecialist", () => {
  it("agentId=risk，无工具（只读指标表），maxSteps=1", () => {
    const spec = buildRiskSpecialist(ctx("zh"))
    expect(spec.agentId).toBe(RISK_AGENT_ID)
    expect(spec.buildTools(ctx("zh"))).toEqual([])
    expect(spec.maxSteps).toBe(1)
    const msgs = spec.buildMessages(ctx("zh"))
    expect(msgs[0].content).toContain("风险解读专家")
  })

  it("委托描述随语言", () => {
    expect(buildRiskSpecialist(ctx("zh")).toolDescription(ctx("zh"))).toContain(
      "风险解读专家"
    )
    expect(buildRiskSpecialist(ctx("en")).toolDescription(ctx("en"))).toContain(
      "risk review"
    )
  })
})

describe("buildSupervisorConfig", () => {
  it("agentId=supervisor，buildTools 原样透传 delegate 工具（不追加自己的工具）", () => {
    const cfg = buildSupervisorConfig(ctx("zh"))
    expect(cfg.agentId).toBe(SUPERVISOR_AGENT_ID)
    const delegate = {
      name: "delegate_reconcile",
      description: "d",
      parameters: {},
      execute: () => "{}",
    }
    expect(cfg.buildTools(ctx("zh"), [delegate])).toEqual([delegate])
    expect(cfg.maxSteps).toBe(4)
    const msgs = cfg.buildMessages(ctx("zh"))
    expect(msgs[0].content).toContain("统筹主管")
  })

  it("提示词硬性要求委托两位专家（时间线确定性的来源）", () => {
    const cfg = buildSupervisorConfig(ctx("zh"))
    const msgs = cfg.buildMessages(ctx("zh"))
    expect(msgs[0].content).toContain("delegate_reconcile")
    expect(msgs[0].content).toContain("delegate_risk")
  })
})
