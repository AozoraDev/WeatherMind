import { describe, expect, it } from "vitest"

import { detectSourceDivergences } from "./divergence"
import type { SourceInput } from "@/lib/schemas/forecast-agent"
import type { WeatherSource } from "@/lib/schemas/weather"

// 造三源输入记录：缺省全源一致（clear、无降水、温差小），测试各自只覆盖目标分歧
function sourceInputs(
  overrides: Partial<Record<WeatherSource, Partial<SourceInput>>> = {}
): Record<WeatherSource, SourceInput> {
  const base = (source: WeatherSource): SourceInput => ({
    source,
    high: 30,
    low: 22,
    precip: 0,
    condition: "clear",
    humidity: 60,
    windMs: 3,
  })
  return {
    "open-meteo": { ...base("open-meteo"), ...(overrides["open-meteo"] ?? {}) },
    openweather: { ...base("openweather"), ...(overrides.openweather ?? {}) },
    weatherapi: { ...base("weatherapi"), ...(overrides.weatherapi ?? {}) },
  }
}

describe("detectSourceDivergences", () => {
  it("全源一致 → 无分歧", () => {
    expect(detectSourceDivergences(sourceInputs())).toEqual([])
  })

  it("降水分歧：单源报雨 vs 其余无雨，湿/干数组按规范序", () => {
    expect(
      detectSourceDivergences(sourceInputs({ openweather: { precip: 5 } }))
    ).toEqual([
      {
        kind: "precip",
        wet: ["openweather"],
        dry: ["open-meteo", "weatherapi"],
      },
    ])
  })

  it("降水边界：precip === 0.1 判湿（与集成阈值同口径，杀 >= → > 突变）", () => {
    // 恰好 0.1 归湿组；若误用 > 0.1 会归干组导致两组都空 → 无分歧，断言失配
    expect(
      detectSourceDivergences(
        sourceInputs({ "open-meteo": { precip: 0.1 } })
      )
    ).toEqual([
      {
        kind: "precip",
        wet: ["open-meteo"],
        dry: ["openweather", "weatherapi"],
      },
    ])
  })

  it("全源报雨 → 湿组非空、干组空 → 无降水分歧（湿/干必须都非空，杀 && → true 与 > 0 → >= 0 突变）", () => {
    expect(
      detectSourceDivergences(
        sourceInputs({
          "open-meteo": { precip: 5 },
          openweather: { precip: 2 },
          weatherapi: { precip: 1 },
        })
      )
    ).toEqual([])
  })

  it("条件分歧：clear vs rain，与降水分歧共存时按 precip → condition 排序", () => {
    expect(
      detectSourceDivergences(
        sourceInputs({
          "open-meteo": { condition: "clear", precip: 0 },
          openweather: { condition: "rain", precip: 5 },
        })
      )
    ).toEqual([
      {
        kind: "precip",
        wet: ["openweather"],
        dry: ["open-meteo", "weatherapi"],
      },
      {
        kind: "condition",
        groups: [
          { condition: "clear", sources: ["open-meteo", "weatherapi"] },
          { condition: "rain", sources: ["openweather"] },
        ],
      },
    ])
  })

  it("条件分组按规范序排序：插入序反序（rain 先插入）仍输出 clear 在前", () => {
    // open-meteo（SOURCE_ORDER 第一个）报 rain、其余报 clear → Map 插入序 rain, clear；
    // 排序后须还原为规范序 clear, rain（杀排序比较器 - → + 与 comparator 删除/数组常量突变）
    expect(
      detectSourceDivergences(
        sourceInputs({
          "open-meteo": { condition: "rain", precip: 5 },
          openweather: { condition: "clear", precip: 0 },
        })
      )
    ).toEqual([
      {
        kind: "precip",
        wet: ["open-meteo"],
        dry: ["openweather", "weatherapi"],
      },
      {
        kind: "condition",
        groups: [
          { condition: "clear", sources: ["openweather", "weatherapi"] },
          { condition: "rain", sources: ["open-meteo"] },
        ],
      },
    ])
  })

  it("null 条件忽略：仅 1 个非 null 类别 → 无条件分歧", () => {
    expect(
      detectSourceDivergences(
        sourceInputs({
          openweather: { condition: null },
          weatherapi: { condition: null },
        })
      )
    ).toEqual([])
  })

  it("高温差 ≥3：high spread 4°C，min/max 保留 1 位小数", () => {
    expect(
      detectSourceDivergences(
        sourceInputs({
          "open-meteo": { high: 30 },
          openweather: { high: 34 },
          weatherapi: { high: 32 },
        })
      )
    ).toEqual([
      { kind: "temperature", metric: "high", spread: 4, min: 30, max: 34 },
    ])
  })

  it("低温差 ≥3：low spread 3.2，只报低温（high 无差，杀 low 判别串突变）", () => {
    expect(
      detectSourceDivergences(
        sourceInputs({
          "open-meteo": { low: 20 },
          openweather: { low: 23.2 },
          weatherapi: { low: 21 },
        })
      )
    ).toEqual([
      { kind: "temperature", metric: "low", spread: 3.2, min: 20, max: 23.2 },
    ])
  })

  it("温差边界：spread === 3.0 判分歧、2.9 不分歧", () => {
    const at3 = detectSourceDivergences(
      sourceInputs({
        "open-meteo": { high: 31 },
        openweather: { high: 34 },
        weatherapi: { high: 32 },
      })
    )
    expect(at3).toEqual([
      { kind: "temperature", metric: "high", spread: 3, min: 31, max: 34 },
    ])
    // spread 2.9 → 无任何分歧
    const below = detectSourceDivergences(
      sourceInputs({
        "open-meteo": { high: 31.1 },
        openweather: { high: 34 },
        weatherapi: { high: 32 },
      })
    )
    expect(below).toEqual([])
  })

  it("两源温差 ≥3 也判分歧（values.length === 2 边界，杀 < 2 → <= 2 突变）", () => {
    const two = {
      "open-meteo": sourceInputs()["open-meteo"],
      openweather: { ...sourceInputs().openweather, high: 34 },
    } as unknown as Record<WeatherSource, SourceInput>
    expect(detectSourceDivergences(two)).toEqual([
      { kind: "temperature", metric: "high", spread: 4, min: 30, max: 34 },
    ])
  })

  it("单源 → 无任何分歧（各组都不满足触发条件）", () => {
    const single = {
      "open-meteo": sourceInputs()["open-meteo"],
    } as unknown as Record<WeatherSource, SourceInput>
    expect(detectSourceDivergences(single)).toEqual([])
  })

  it("乱序 key 输入仍按规范序输出（结果不依赖对象字面量 key 顺序）", () => {
    const out = {
      weatherapi: { ...sourceInputs().weatherapi },
      openweather: { ...sourceInputs({ openweather: { precip: 2 } }).openweather },
      "open-meteo": { ...sourceInputs()["open-meteo"] },
    } as unknown as Record<WeatherSource, SourceInput>
    expect(detectSourceDivergences(out)).toEqual([
      {
        kind: "precip",
        wet: ["openweather"],
        dry: ["open-meteo", "weatherapi"],
      },
    ])
  })
})
