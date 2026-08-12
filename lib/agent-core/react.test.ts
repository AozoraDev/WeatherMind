import { describe, expect, it } from "vitest"

import { reactTraceSchema } from "@/lib/schemas/forecast-agent"

import { executeToolCalls, mergeUsage, safeParseJson, type ReactTool } from "./react"

describe("safeParseJson", () => {
  it("合法 JSON 返回 value；非法返回 ok:false", () => {
    expect(safeParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(safeParseJson("not json")).toEqual({ ok: false })
  })
})

describe("mergeUsage", () => {
  it("两侧都有 → 逐字段求和", () => {
    expect(
      mergeUsage(
        { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      )
    ).toEqual({ prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 })
  })

  it("a 缺省 → 返回 b；b 缺省 → 返回 a；两侧都空 → null", () => {
    const b = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    expect(mergeUsage(null, b)).toBe(b)
    expect(mergeUsage(b, null)).toBe(b)
    expect(mergeUsage(null, null)).toBeNull()
  })
})

describe("executeToolCalls", () => {
  const tool: ReactTool = {
    name: "query_source",
    description: "query",
    parameters: {},
    execute: (args) => JSON.stringify({ got: args }),
  }

  it("调用工具并回传结果，构造 assistant 侧的 tool 消息", async () => {
    const { actions, toolMsgs } = await executeToolCalls([tool], [
      { id: "c1", name: "query_source", arguments: '{"a":1}' },
    ])
    expect(actions).toEqual([
      { name: "query_source", args: '{"a":1}', result: '{"got":{"a":1}}' },
    ])
    expect(toolMsgs).toEqual([
      { role: "tool", tool_call_id: "c1", content: '{"got":{"a":1}}' },
    ])
  })

  it("异步工具（execute 返回 Promise）同样拿到结果", async () => {
    const asyncTool: ReactTool = {
      ...tool,
      execute: async (args) => JSON.stringify({ got: args, async: true }),
    }
    const { actions } = await executeToolCalls([asyncTool], [
      { id: "c1", name: "query_source", arguments: '{"a":1}' },
    ])
    expect(actions[0].result).toBe('{"got":{"a":1},"async":true}')
  })

  it("未知工具 → error 观察喂回模型", async () => {
    const { actions } = await executeToolCalls([tool], [
      { id: "c1", name: "nope", arguments: "{}" },
    ])
    expect(actions[0].result).toBe('{"error":"unknown tool: nope"}')
  })

  it("参数非法 JSON → error 观察", async () => {
    const { actions } = await executeToolCalls([tool], [
      { id: "c1", name: "query_source", arguments: "not-json" },
    ])
    expect(actions[0].result).toBe('{"error":"arguments are not valid JSON"}')
  })

  it("空串 / 字面 null 参数 → 按空对象 {} 调用（无参 delegate 工具兜底）", async () => {
    // 部分模型对无参工具发 "" 或 "null"；应视为 {} 正常调用，而非非法参数
    for (const blank of ["", " ", "null"]) {
      const { actions } = await executeToolCalls([tool], [
        { id: "c1", name: "query_source", arguments: blank },
      ])
      expect(actions[0].result).toBe('{"got":{}}')
    }
  })

  it("参数是数组或标量 → 要求 JSON 对象", async () => {
    const { actions } = await executeToolCalls([tool], [
      { id: "c1", name: "query_source", arguments: "[1,2]" },
    ])
    expect(actions[0].result).toBe('{"error":"arguments must be a JSON object"}')
  })

  it("工具执行抛错 → error 观察，不中止循环", async () => {
    const throwing: ReactTool = {
      ...tool,
      execute: () => {
        throw new Error("boom")
      },
    }
    const { actions } = await executeToolCalls([throwing], [
      { id: "c1", name: "query_source", arguments: "{}" },
    ])
    expect(actions[0].result).toBe('{"error":"tool execution failed"}')
  })

  it("异步工具 reject → error 观察，不中止循环", async () => {
    const rejecting: ReactTool = {
      ...tool,
      execute: async () => {
        throw new Error("boom")
      },
    }
    const { actions } = await executeToolCalls([rejecting], [
      { id: "c1", name: "query_source", arguments: "{}" },
    ])
    expect(actions[0].result).toBe('{"error":"tool execution failed"}')
  })
})

describe("reactTraceSchema", () => {
  it("合法轨迹通过、非法数据拒绝（卡片读回信任边界）", () => {
    expect(reactTraceSchema.safeParse([]).success).toBe(true)
    expect(
      reactTraceSchema.safeParse([
        { thought: "核对", actions: [{ name: "a", args: "{}", result: "{}" }] },
      ]).success
    ).toBe(true)
    // thought 非法（非 null 非字符串）与整体非数组均拒绝
    expect(
      reactTraceSchema.safeParse([{ thought: 1, actions: [] }]).success
    ).toBe(false)
    expect(reactTraceSchema.safeParse("nope").success).toBe(false)
  })

  it("带 agent_id 的步骤通过；不带 agent_id 的旧行也通过（nullish 兼容）", () => {
    // 新行：步骤带所属 agent
    expect(
      reactTraceSchema.safeParse([
        {
          thought: "委托核对",
          actions: [{ name: "delegate_reconcile", args: "{}", result: "{}" }],
          agent_id: "supervisor",
        },
      ]).success
    ).toBe(true)
    // 旧行：无 agent_id → 默认 null 通过（前端回落单组时间线）
    expect(
      reactTraceSchema.safeParse([
        { thought: null, actions: [{ name: "a", args: "{}", result: "{}" }] },
      ]).success
    ).toBe(true)
    // agent_id 必须字符串/null，数值拒绝（杀 nullish→required 突变）
    expect(
      reactTraceSchema.safeParse([
        { thought: null, actions: [], agent_id: 42 },
      ]).success
    ).toBe(false)
  })
})
