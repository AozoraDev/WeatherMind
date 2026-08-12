import { describe, expect, it } from "vitest"

import { buildMainAgentMessages, buildMainAgentSystemPrompt } from "./prompt"

describe("buildMainAgentSystemPrompt", () => {
  it("中文：含今日日期、平台背景、意图分流、3 源默认与去重复铁律", () => {
    const p = buildMainAgentSystemPrompt("zh", "2026-08-11")
    expect(p).toContain("2026-08-11")
    expect(p).toContain("query_city")
    expect(p).toContain("query_sources")
    expect(p).toContain("query_weather_history")
    expect(p).toContain("query_forecast")
    expect(p).toContain("generate_forecast")
    expect(p).toContain("子 Agent")
    expect(p).toContain("Open-Meteo")
    // 意图分流：没问权威预报 → 默认 query_sources 给 3 源；历史 → query_weather_history；问预报 → query_forecast 委托链
    expect(p).toContain("query_sources")
    expect(p).toContain("3 个数据源各自的信息")
    expect(p).toContain("query_weather_history")
    expect(p).toContain("generate_forecast")
    // 去重复：a2ui 图标卡片已展示关键指标，正文不要表格/逐条罗列
    expect(p).toContain("图标卡片")
    expect(p).toContain("不要再次输出指标表格")
    expect(p).toMatch(/[一-鿿]/) // 简体中文，防英文文案漂移
  })

  it("英文：含今日日期、意图分流与去重复铁律，无中文字符", () => {
    const p = buildMainAgentSystemPrompt("en", "2026-08-11")
    expect(p).toContain("2026-08-11")
    expect(p).toContain("query_city")
    expect(p).toContain("query_sources")
    expect(p).toContain("query_weather_history")
    expect(p).toContain("query_forecast")
    expect(p).toContain("generate_forecast")
    expect(p).toContain("sub-agent")
    expect(p).toContain("icon card")
    expect(p).toContain("do NOT restate the metrics as a table")
    expect(p).not.toMatch(/[一-鿿]/) // 英文模式不得混入中文
  })
})

describe("buildMainAgentMessages", () => {
  it("空历史 → 只回 system 主 Agent 提示词", () => {
    const msgs = buildMainAgentMessages([], "zh", "2026-08-11")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({
      role: "system",
      content: buildMainAgentSystemPrompt("zh", "2026-08-11"),
    })
  })

  it("历史按 user/assistant 映射，前置 system 提示词", () => {
    const msgs = buildMainAgentMessages(
      [
        { role: "user", content: "hi", created_at: "2026-01-01T00:00:00Z" },
        { role: "assistant", content: "hello", created_at: "2026-01-01T00:00:01Z" },
      ],
      "en",
      "2026-08-11"
    )
    expect(msgs).toHaveLength(3)
    expect(msgs[0].role).toBe("system")
    expect(msgs[1]).toEqual({ role: "user", content: "hi" })
    expect(msgs[2]).toEqual({ role: "assistant", content: "hello" })
  })
})
