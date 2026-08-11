import { describe, expect, it } from "vitest"

import { reactTraceSchema } from "@/lib/schemas/forecast-agent"

import { safeParseJson } from "./react"

describe("safeParseJson", () => {
  it("合法 JSON 返回 value；非法返回 ok:false", () => {
    expect(safeParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(safeParseJson("not json")).toEqual({ ok: false })
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
})
