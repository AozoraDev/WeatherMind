import { describe, expect, it } from "vitest"

import {
  splitMarkdownDoc,
  validateMarkdownDoc,
  type PredictionResult,
} from "./forecast-agent"

// —— 纯 Markdown 输出契约（新） ——
// splitMarkdownDoc 按语言标题切两段；validateMarkdownDoc 做轻量校验：
// 两段齐 + 长度 + 关键数值（high/low/poP）与集成结果容差内一致 + 防胡编钳制。
// 预报正文必须含温度数字，故不再禁止温度单位（与旧结构化输出时代相反）

// validateMarkdownDoc 只读 high/low/poP，其余字段类型断言即可
const MD_RESULT = {
  high: 30.4,
  low: 22.4,
  poP: 0,
} as unknown as PredictionResult
const MD_RESULT_POP = {
  high: 30.4,
  low: 22.4,
  poP: 10,
} as unknown as PredictionResult

describe("splitMarkdownDoc", () => {
  it("切出 reasoning 与 forecast 两段", () => {
    const md = "## 推理过程\n因为 A。\n## 预报\n高温 30°C。\n"
    expect(splitMarkdownDoc(md)).toEqual({
      reasoning: "因为 A。",
      forecast: "高温 30°C。",
    })
  })

  it("英文标题同样识别（## Reasoning / ## Forecast）", () => {
    const md = "## Reasoning\nBecause A.\n## Forecast\nHigh 30°C.\n"
    expect(splitMarkdownDoc(md)).toEqual({
      reasoning: "Because A.",
      forecast: "High 30°C.",
    })
  })

  it("缺少任一标题 / 顺序颠倒 → null", () => {
    expect(splitMarkdownDoc("## 推理过程\n没有预报")).toBeNull()
    expect(splitMarkdownDoc("## 预报\n没有推理")).toBeNull()
    expect(splitMarkdownDoc("## 预报\n先\n## 推理过程\n后")).toBeNull()
  })
})

describe("validateMarkdownDoc", () => {
  it("合法文档通过（poP=0 允许「无降水」措辞，不必写 0%）", () => {
    const md = `## 推理过程
本次预报基于 open-meteo 与 openweather 两源的确定性集成计算。两源均报晴且无降水，加权集成后预测高温约 30°C、低温约 22°C，体感舒适。
## 预报
今日天气晴朗，预测高温 30°C，低温 22°C，降水概率很低，无需担心降水。`
    expect(validateMarkdownDoc(md, MD_RESULT)).toEqual({
      ok: true,
      doc: expect.objectContaining({ reasoning: expect.any(String) }),
    })
  })

  it("缺段落 → missing-sections", () => {
    const res = validateMarkdownDoc("## 预报\n高温 30°C。", MD_RESULT)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("missing-sections")
  })

  it("文档过短 → too-short", () => {
    const res = validateMarkdownDoc(
      "## 推理过程\n短\n## 预报\n高温 30°C。",
      MD_RESULT
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("too-short")
  })

  it("forecast 段无与集成 high 容差内的温度 → high-mismatch", () => {
    const md = `## 推理过程
基于两源确定性集成计算，加权平均得到预测高温与低温，两源均报晴且无降水，天气稳定。
## 预报
今日预测高温 40°C，低温 22°C，降水概率很低。`
    const res = validateMarkdownDoc(md, MD_RESULT)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("high-mismatch")
  })

  it("forecast 段无与集成 low 容差内的温度 → low-mismatch", () => {
    const md = `## 推理过程
基于两源确定性集成计算，加权平均得到预测高温与低温，两源均报晴且无降水，天气稳定。
## 预报
今日预测高温 30°C，低温 8°C，降水概率很低。`
    const res = validateMarkdownDoc(md, MD_RESULT)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("low-mismatch")
  })

  it("poP 非零但无容差内百分比 → pop-mismatch", () => {
    const md = `## 推理过程
基于两源确定性集成计算，加权平均得到预测高温与低温，两源均报晴且有降水概率。
## 预报
今日预测高温 30°C，低温 22°C，降水概率 50%。`
    const res = validateMarkdownDoc(md, MD_RESULT_POP)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("pop-mismatch")
  })

  it("温度超出合理钳制 → temperature-out-of-range", () => {
    const md = `## 推理过程
基于两源确定性集成计算，加权平均得到预测高温与低温，两源均报晴且无降水，天气稳定。
## 预报
今日预测高温 80°C，低温 22°C，降水概率很低。`
    const res = validateMarkdownDoc(md, MD_RESULT)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("temperature-out-of-range")
  })

  it("百分比超过 100 → percent-out-of-range", () => {
    const md = `## 推理过程
基于两源确定性集成计算，加权平均得到预测高温与低温，两源均报晴且无降水，天气稳定。
## 预报
今日预测高温 30°C，低温 22°C，降水概率 150%。`
    const res = validateMarkdownDoc(md, MD_RESULT)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("percent-out-of-range")
  })

  it("reasoning 为空 → empty-reasoning", () => {
    const md = `## 推理过程

## 预报
今日天气晴朗，预测高温 30°C，低温 22°C，降水概率很低，无需担心降水。`
    const res = validateMarkdownDoc(md, MD_RESULT)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("empty-reasoning")
  })

  it("forecast 为空 → empty-forecast", () => {
    const md = `## 推理过程
本次预报基于两源的确定性集成计算，两源均报晴且无降水，加权集成后预测高温约 30°C、低温约 22°C。
## 预报
`
    const res = validateMarkdownDoc(md, MD_RESULT)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.issues).toContain("empty-forecast")
  })

  it("容差/钳制参数可自定义（opts 覆盖默认值）", () => {
    // 默认 2.5°C 下 32°C 对 high=30.4 是 mismatch；放宽 tempTolerance=2 后仍不通过，
    // 再放宽到 3 才通过 → 验证 opts 生效
    const md = `## 推理过程
基于两源确定性集成计算，加权平均得到预测高温与低温，两源均报晴且无降水，天气稳定。
## 预报
今日预测高温 32°C，低温 22°C，降水概率很低。`
    expect(validateMarkdownDoc(md, MD_RESULT, { tempTolerance: 1 }).ok).toBe(
      false
    )
    expect(validateMarkdownDoc(md, MD_RESULT, { tempTolerance: 3 }).ok).toBe(
      true
    )
  })
})
