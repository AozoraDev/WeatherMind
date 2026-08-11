import { describe, expect, it } from "vitest"

import {
  extractDataPayloads,
  isDonePayload,
  splitSseEvents,
} from "./sse"

// SSE 帧解析纯函数：按 \n\n 切块、剥 data: 壳、判 [DONE]。
// provider（上游 OpenAI 流）与前端 hook（本项目 SSE 包）共用，行为必须稳定

describe("splitSseEvents", () => {
  it("无完整块：整体作为 rest 返回", () => {
    expect(splitSseEvents('data: {"a":1}\n')).toEqual({
      blocks: [],
      rest: 'data: {"a":1}\n',
    })
  })

  it("单块完整事件", () => {
    expect(splitSseEvents('data: {"a":1}\n\n')).toEqual({
      blocks: ['data: {"a":1}'],
      rest: "",
    })
  })

  it("多块切分 + 末尾半截事件保留为 rest", () => {
    // 末块 `data: {"c":3}\n` 未以空行 \n\n 收尾 → 视为半截进 rest，不误切为完整块
    const input =
      'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n'
    const res = splitSseEvents(input)
    expect(res.blocks).toEqual(['data: {"a":1}', 'data: {"b":2}'])
    expect(res.rest).toBe('data: {"c":3}\n')
  })

  it("末块不完整（无 \n\n 收尾）→ 进 rest，不误切", () => {
    const input = 'data: {"a":1}\n\ndata: {"b":2'
    const res = splitSseEvents(input)
    expect(res.blocks).toEqual(['data: {"a":1}'])
    expect(res.rest).toBe('data: {"b":2')
  })

  it("多块 + 末尾不完整 rest 同时存在", () => {
    const input = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3\n'
    const res = splitSseEvents(input)
    expect(res.blocks).toEqual(['data: {"a":1}', 'data: {"b":2}'])
    expect(res.rest).toBe("data: {" + '"c":3\n')
  })

  it("\\r\\n 行尾归一为 \\n（fetch 读回可能带 \\r）", () => {
    // 以 \r\n\r\n 收尾表示完整事件；规整后应切出两完整块、rest 为空
    const res = splitSseEvents('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n')
    expect(res.blocks).toEqual(['data: {"a":1}', 'data: {"b":2}'])
    expect(res.rest).toBe("")
  })

  it("空缓冲 → 空块空 rest", () => {
    expect(splitSseEvents("")).toEqual({ blocks: [], rest: "" })
  })
})

describe("extractDataPayloads", () => {
  it("剥 data: 前缀并 trim", () => {
    expect(extractDataPayloads('data: {"a":1}')).toEqual(['{"a":1}'])
    expect(extractDataPayloads("data:   hello  ")).toEqual(["hello"])
  })

  it("一个事件块内多行 data 全部取出（SSE 多行消息）", () => {
    const block = 'data: {"a":\ndata: 1}'
    expect(extractDataPayloads(block)).toEqual(['{"a":', "1}"])
  })

  it("注释行（: 开头）忽略", () => {
    const block = ': keep-alive\ndata: {"a":1}'
    expect(extractDataPayloads(block)).toEqual(['{"a":1}'])
  })

  it("无 data 行 → 空数组", () => {
    expect(extractDataPayloads("event: message")).toEqual([])
  })
})

describe("isDonePayload", () => {
  it("[DONE] 与带空白变体为真", () => {
    expect(isDonePayload("[DONE]")).toBe(true)
    expect(isDonePayload("  [DONE]  ")).toBe(true)
  })

  it("其他内容为假", () => {
    expect(isDonePayload('{"a":1}')).toBe(false)
    expect(isDonePayload("DONE")).toBe(false)
    expect(isDonePayload("")).toBe(false)
  })
})
