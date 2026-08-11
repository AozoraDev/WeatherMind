import { describe, expect, it } from "vitest"

import type { SourceInput } from "@/lib/schemas/forecast-agent"
import type { WeatherSource } from "@/lib/schemas/weather"

import {
  beaufort,
  confidence,
  conditionVote,
  precipLevel,
  precipitationProbability,
  predictionInterval,
  predict,
  riskFlags,
  weightedMean,
  weightedStd,
} from "./ensemble"

// 构造单源输入；condition/humidity/windMs 可缺
function src(
  source: SourceInput["source"],
  high: number,
  low: number,
  precip: number,
  condition: SourceInput["condition"],
  humidity: number | null = null,
  windMs: number | null = null
): SourceInput {
  return { source, high, low, precip, condition, humidity, windMs }
}

const W = { "open-meteo": 0.5, openweather: 0.3, weatherapi: 0.2 }

// 模拟 computeWeights 返回值（Weights）：三源权重 + detail 明细字段。
// 回归：历史 bug 中 Object.values(weights) 把 detail 对象混入求和，导致 total 变字符串、poP 算出 NaN
const WD = {
  ...W,
  detail: { alpha: 0.7, beta: 0.3, gamma: 0, prior: {}, consistency: {}, mae: {} },
}

describe("weightedMean", () => {
  it("普通加权均值", () => {
    expect(weightedMean([30, 32, 31], [0.5, 0.3, 0.2])).toBeCloseTo(30.8)
  })

  it("权重全 0 返回 0", () => {
    expect(weightedMean([30, 32], [0, 0])).toBe(0)
  })

  it("空数组返回 0", () => {
    expect(weightedMean([], [])).toBe(0)
  })

  it("权重数组比值短时缺失权重按 0 计", () => {
    // 仅前两项有权重，第三项 weights[2] 为 undefined → ?? 0
    expect(weightedMean([30, 32, 31], [0.5, 0.3])).toBeCloseTo(30.75)
  })

  it("单值均值等于该值", () => {
    expect(weightedMean([30], [1])).toBe(30)
  })
})

describe("weightedStd", () => {
  it("权重全在一点时标准差为 0", () => {
    expect(weightedStd([31, 31, 31], [0.5, 0.3, 0.2], 31)).toBe(0)
  })

  it("离散值有非零标准差", () => {
    expect(weightedStd([30, 34], [0.5, 0.5], 32)).toBeCloseTo(2)
  })

  it("权重全 0 返回 0", () => {
    expect(weightedStd([30, 34], [0, 0], 32)).toBe(0)
  })

  it("权重缺失时按 0 计", () => {
    // 第二项无权重 → (weights[1] ?? 0)=0，方差只来自第一项
    expect(weightedStd([30, 34], [0.5], 32)).toBeCloseTo(2)
  })

  it("单值标准差为 0", () => {
    expect(weightedStd([30], [1], 30)).toBe(0)
  })
})

describe("precipitationProbability", () => {
  it("报雨源权重占比即概率", () => {
    const inputs = [
      src("open-meteo", 30, 20, 8, "rain"),
      src("openweather", 30, 20, 5, "rain"),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    // 0.5 + 0.3 = 0.8 → 80%
    expect(precipitationProbability(inputs, W)).toBe(80)
  })

  it("全部报雨 → 100", () => {
    const inputs = [
      src("open-meteo", 30, 20, 1, "rain"),
      src("openweather", 30, 20, 1, "rain"),
      src("weatherapi", 30, 20, 1, "rain"),
    ]
    expect(precipitationProbability(inputs, W)).toBe(100)
  })

  it("都不报雨 → 0", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "clear"),
      src("openweather", 30, 20, 0, "clear"),
    ]
    expect(precipitationProbability(inputs, W)).toBe(0)
  })

  it("权重全 0 返回 0", () => {
    const inputs = [src("open-meteo", 30, 20, 5, "rain")]
    expect(
      precipitationProbability(inputs, {
        "open-meteo": 0,
        openweather: 0,
        weatherapi: 0,
      })
    ).toBe(0)
  })

  it("恰好 0.1 也算报雨", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0.1, "rain"),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    // total 为权重表全量和 1.0；rainWeight 0.5 → 50
    expect(precipitationProbability(inputs, W)).toBe(50)
  })

  it("四舍五入到整数", () => {
    const inputs = [
      src("open-meteo", 30, 20, 5, "rain"),
      src("openweather", 30, 20, 0, "clear"),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    // 1/3 → 33.33 → 33
    expect(
      precipitationProbability(inputs, {
        "open-meteo": 1,
        openweather: 1,
        weatherapi: 1,
      })
    ).toBe(33)
  })

  it("权重缺失的源按 0 计", () => {
    const inputs = [
      src("open-meteo", 30, 20, 5, "rain"),
      src("weatherapi", 30, 20, 5, "rain"),
    ]
    // 权重表缺 weatherapi：rainWeight = 0.5，total = 0.5 → 100
    expect(
      precipitationProbability(inputs, { "open-meteo": 0.5 } as Record<
        WeatherSource,
        number
      >)
    ).toBe(100)
  })

  it("带 detail 明细的权重表不影响结果（回归：曾算出 NaN）", () => {
    const inputs = [
      src("open-meteo", 30, 20, 8, "rain"),
      src("openweather", 30, 20, 5, "rain"),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    // 0.5 + 0.3 = 0.8 → 80%，而非 NaN
    expect(precipitationProbability(inputs, WD)).toBe(80)
  })
})

describe("precipLevel", () => {
  it("边界映射：0.1 起小雨、10 起中雨、25 起大雨", () => {
    expect(precipLevel(0)).toBe("none")
    expect(precipLevel(0.05)).toBe("none")
    expect(precipLevel(5)).toBe("light")
    expect(precipLevel(12)).toBe("moderate")
    expect(precipLevel(30)).toBe("heavy")
  })

  it("精确边界：0.1/10/25 与下方值", () => {
    expect(precipLevel(0.1)).toBe("light")
    expect(precipLevel(9.9)).toBe("light")
    expect(precipLevel(10)).toBe("moderate")
    expect(precipLevel(24.9)).toBe("moderate")
    expect(precipLevel(25)).toBe("heavy")
  })
})

describe("conditionVote", () => {
  it("加权多数胜出", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "clear"),
      src("openweather", 30, 20, 0, "cloudy"),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    // clear 0.5+0.2=0.7 > cloudy 0.3
    expect(conditionVote(inputs, W)).toBe("clear")
  })

  it("条件缺失的源不参与投票", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, null),
      src("openweather", 30, 20, 0, "rain"),
      src("weatherapi", 30, 20, 0, "rain"),
    ]
    expect(conditionVote(inputs, W)).toBe("rain")
  })

  it("全部缺失回退 other", () => {
    const inputs = [src("open-meteo", 30, 20, 0, null)]
    expect(conditionVote(inputs, W)).toBe("other")
  })

  it("空输入回退 other", () => {
    expect(conditionVote([], W)).toBe("other")
  })

  it("权重缺失的源按 0 票计", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "rain"),
      src("openweather", 30, 20, 0, "clear"),
      src("weatherapi", 30, 20, 0, "cloudy"),
    ]
    // weatherapi 不在权重表 → ?? 0 → 0 票；rain 0.5 胜出
    expect(
      conditionVote(inputs, { "open-meteo": 0.5, openweather: 0.3 } as Record<
        WeatherSource,
        number
      >)
    ).toBe("rain")
  })

  it("并列时取先出现者", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "rain"),
      src("openweather", 30, 20, 0, "clear"),
    ]
    // rain 与 clear 各 0.5，严格 > 让先出现者 rain 胜出
    expect(
      conditionVote(inputs, {
        "open-meteo": 0.5,
        openweather: 0.5,
        weatherapi: 0,
      })
    ).toBe("rain")
  })
})

describe("beaufort", () => {
  it("标准查表边界", () => {
    expect(beaufort(0)).toBe(0)
    expect(beaufort(3)).toBe(2)
    expect(beaufort(8)).toBe(5)
    expect(beaufort(14)).toBe(7)
    expect(beaufort(40)).toBe(12)
  })

  it("每个阈值边界：下方值取低风级、精确值取高风级", () => {
    expect(beaufort(0.29)).toBe(0)
    expect(beaufort(0.3)).toBe(1)
    expect(beaufort(1.59)).toBe(1)
    expect(beaufort(1.6)).toBe(2)
    expect(beaufort(3.39)).toBe(2)
    expect(beaufort(3.4)).toBe(3)
    expect(beaufort(5.49)).toBe(3)
    expect(beaufort(5.5)).toBe(4)
    expect(beaufort(7.99)).toBe(4)
    expect(beaufort(8.0)).toBe(5)
    expect(beaufort(10.79)).toBe(5)
    expect(beaufort(10.8)).toBe(6)
    expect(beaufort(13.89)).toBe(6)
    expect(beaufort(13.9)).toBe(7)
    expect(beaufort(17.19)).toBe(7)
    expect(beaufort(17.2)).toBe(8)
    expect(beaufort(20.79)).toBe(8)
    expect(beaufort(20.8)).toBe(9)
    expect(beaufort(24.49)).toBe(9)
    expect(beaufort(24.5)).toBe(10)
    expect(beaufort(28.49)).toBe(10)
    expect(beaufort(28.5)).toBe(11)
    expect(beaufort(32.69)).toBe(11)
    expect(beaufort(32.7)).toBe(12)
  })

  it("负值取绝对值", () => {
    expect(beaufort(-0.3)).toBe(1)
    expect(beaufort(-5.5)).toBe(4)
  })
})

describe("predictionInterval", () => {
  it("均值 ± z×σ 且保留 1 位小数", () => {
    expect(predictionInterval(32.35, 1.3)).toEqual([30.7, 34])
  })
})

describe("confidence", () => {
  it("多数派权重 ≥75% 高置信", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "clear"),
      src("openweather", 30, 20, 0, "clear"),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    expect(confidence(inputs, W)).toBe("high")
  })

  it("分歧时中置信", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "rain"),
      src("openweather", 30, 20, 0, "clear"),
      src("weatherapi", 30, 20, 0, "cloudy"),
    ]
    // 最大 0.5 → [0.5,0.75)
    expect(confidence(inputs, W)).toBe("medium")
  })

  it("多数派权重 <50% 低置信", () => {
    // 仅 weatherapi(0.2) 有条件，其余源条件缺失不投票 → 占比 0.2
    const inputs = [
      src("open-meteo", 30, 20, 0, null),
      src("openweather", 30, 20, 0, null),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    expect(confidence(inputs, W)).toBe("low")
  })

  it("权重全 0 回退 total=1 → low", () => {
    const inputs = [src("open-meteo", 30, 20, 0, "clear")]
    // total = 0 → || 1 = 1；share = 0/1 = 0 → low
    expect(
      confidence(inputs, {
        "open-meteo": 0,
        openweather: 0,
        weatherapi: 0,
      })
    ).toBe("low")
  })

  it("全部条件缺失 → low（空票表）", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, null),
      src("openweather", 30, 20, 0, null),
      src("weatherapi", 30, 20, 0, null),
    ]
    // Math.max(0) = 0 → 0/1 = 0 → low
    expect(confidence(inputs, W)).toBe("low")
  })

  it("占比恰好 0.75 → high", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "clear"),
      src("openweather", 30, 20, 0, "rain"),
      src("weatherapi", 30, 20, 0, "cloudy"),
    ]
    // clear 0.75 / 总 1.0 → share 恰好 0.75
    expect(
      confidence(inputs, {
        "open-meteo": 0.75,
        openweather: 0.15,
        weatherapi: 0.1,
      })
    ).toBe("high")
  })

  it("占比恰好 0.5 → medium", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "clear"),
      src("openweather", 30, 20, 0, "rain"),
      src("weatherapi", 30, 20, 0, "cloudy"),
    ]
    // 最大 0.5 / 总 1.0 → 恰好 0.5
    expect(confidence(inputs, W)).toBe("medium")
  })

  it("总权重非 1 时按实际总和归一", () => {
    const inputs = [src("open-meteo", 30, 20, 0, "clear")]
    // 唯一源权重 0.3 → share = 0.3/0.3 = 1 → high
    expect(
      confidence(inputs, {
        "open-meteo": 0.3,
        openweather: 0,
        weatherapi: 0,
      })
    ).toBe("high")
  })

  it("权重缺失的源按 0 计", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "clear"),
      src("openweather", 30, 20, 0, "rain"),
      src("weatherapi", 30, 20, 0, "cloudy"),
    ]
    // weatherapi 不在权重表 → 0 票；share = 0.5/0.8 = 0.625 → medium
    expect(
      confidence(inputs, { "open-meteo": 0.5, openweather: 0.3 } as Record<
        WeatherSource,
        number
      >)
    ).toBe("medium")
  })

  it("带 detail 明细的权重表不破坏置信计算（回归：曾算出 NaN → 恒 low）", () => {
    const inputs = [
      src("open-meteo", 30, 20, 0, "clear"),
      src("openweather", 30, 20, 0, "clear"),
      src("weatherapi", 30, 20, 0, "clear"),
    ]
    // 0.5+0.3+0.2 = 1.0，clear 全票 → high；而非 NaN → low
    expect(confidence(inputs, WD)).toBe("high")
  })
})

describe("riskFlags", () => {
  it("高温触发 heat 风险", () => {
    const inputs = [
      src("open-meteo", 36, 26, 0, "clear"),
      src("openweather", 36, 26, 0, "clear"),
    ]
    const pred = {
      high: 36,
      low: 26,
      precip: 0,
      poP: 0,
      windBeaufort: 3,
      condition: "clear" as const,
    }
    const flags = riskFlags(inputs, pred)
    expect(flags.some((f) => f.type === "heat" && f.level === "warning")).toBe(
      true
    )
  })

  it("高温边界：正好 35 触发、34.9 不触发", () => {
    const inputs = [src("open-meteo", 35, 25, 0, "clear")]
    const predYes = {
      high: 35,
      low: 25,
      precip: 0,
      poP: 0,
      windBeaufort: 2,
      condition: "clear" as const,
    }
    expect(riskFlags(inputs, predYes).some((f) => f.type === "heat")).toBe(true)

    const predNo = {
      high: 34.9,
      low: 25,
      precip: 0,
      poP: 0,
      windBeaufort: 2,
      condition: "clear" as const,
    }
    expect(riskFlags(inputs, predNo).some((f) => f.type === "heat")).toBe(false)
  })

  it("低温边界：low=0 触发、0.1 不触发", () => {
    const inputs = [src("open-meteo", 10, 0, 0, "clear")]
    const predYes = {
      high: 10,
      low: 0,
      precip: 0,
      poP: 0,
      windBeaufort: 2,
      condition: "clear" as const,
    }
    expect(
      riskFlags(inputs, predYes).some(
        (f) => f.type === "cold" && f.level === "warning"
      )
    ).toBe(true)

    const predNo = {
      high: 10,
      low: 0.1,
      precip: 0,
      poP: 0,
      windBeaufort: 2,
      condition: "clear" as const,
    }
    expect(riskFlags(inputs, predNo).some((f) => f.type === "cold")).toBe(false)
  })

  it("大雨边界：precip≥25 且 poP≥60 才标 heavyRain", () => {
    const inputs = [src("open-meteo", 30, 20, 25, "rain")]
    const predYes = {
      high: 30,
      low: 20,
      precip: 25,
      poP: 60,
      windBeaufort: 2,
      condition: "rain" as const,
    }
    expect(
      riskFlags(inputs, predYes).some(
        (f) => f.type === "heavyRain" && f.level === "warning"
      )
    ).toBe(true)

    // precip 达标但 poP 不够 → 不标
    const predNoPop = {
      high: 30,
      low: 20,
      precip: 25,
      poP: 59,
      windBeaufort: 2,
      condition: "rain" as const,
    }
    expect(
      riskFlags(inputs, predNoPop).some((f) => f.type === "heavyRain")
    ).toBe(false)
  })

  it("大风边界：windBeaufort=6 触发、5 不触发", () => {
    const inputs = [src("open-meteo", 30, 20, 0, "clear")]
    const predYes = {
      high: 30,
      low: 20,
      precip: 0,
      poP: 0,
      windBeaufort: 6,
      condition: "clear" as const,
    }
    expect(
      riskFlags(inputs, predYes).some(
        (f) => f.type === "wind" && f.level === "warning"
      )
    ).toBe(true)

    const predNo = {
      high: 30,
      low: 20,
      precip: 0,
      poP: 0,
      windBeaufort: 5,
      condition: "clear" as const,
    }
    expect(riskFlags(inputs, predNo).some((f) => f.type === "wind")).toBe(false)
  })

  it("雷暴需 ≥2 源一致才标", () => {
    const single = [
      src("open-meteo", 28, 22, 5, "storm"),
      src("openweather", 28, 22, 0, "clear"),
    ]
    const pred = {
      high: 28,
      low: 22,
      precip: 5,
      poP: 30,
      windBeaufort: 3,
      condition: "storm" as const,
    }
    expect(riskFlags(single, pred).some((f) => f.type === "storm")).toBe(false)

    const two = [
      src("open-meteo", 28, 22, 5, "storm"),
      src("openweather", 28, 22, 5, "storm"),
    ]
    // 两个 storm 源 → sources = count("storm") = 2
    expect(
      riskFlags(two, pred).some(
        (f) => f.type === "storm" && f.level === "warning" && f.sources === 2
      )
    ).toBe(true)
  })

  it("降雪 ≥2 源一致触发 snow", () => {
    const inputs = [
      src("open-meteo", 2, -2, 5, "snow"),
      src("openweather", 2, -2, 5, "snow"),
    ]
    const pred = {
      high: 2,
      low: -2,
      precip: 5,
      poP: 30,
      windBeaufort: 3,
      condition: "snow" as const,
    }
    const flags = riskFlags(inputs, pred)
    // sources = count("snow") = 2（源数非权重）
    expect(
      flags.some(
        (f) => f.type === "snow" && f.level === "warning" && f.sources === 2
      )
    ).toBe(true)
  })

  it("pred 报 storm 但无源报 storm → count 兜底 0，不标雷暴", () => {
    // count("storm") 的 Map 无该 key → ?? 0 兜底（杀条件源计数突变）
    const inputs = [
      src("open-meteo", 28, 22, 5, "clear"),
      src("openweather", 28, 22, 5, "clear"),
    ]
    const pred = {
      high: 28,
      low: 22,
      precip: 5,
      poP: 30,
      windBeaufort: 3,
      condition: "storm" as const,
    }
    expect(riskFlags(inputs, pred).some((f) => f.type === "storm")).toBe(false)
  })

  it("条件缺失源不计入一致源数", () => {
    // 一个 snow + 一个 null：count("snow")=1 < 2，不标
    const inputs = [
      src("open-meteo", 2, -2, 5, "snow"),
      src("openweather", 2, -2, 5, null),
    ]
    const pred = {
      high: 2,
      low: -2,
      precip: 5,
      poP: 30,
      windBeaufort: 3,
      condition: "snow" as const,
    }
    expect(riskFlags(inputs, pred).some((f) => f.type === "snow")).toBe(false)
  })

  it("昼夜温差正好 10 触发、9.9 不触发", () => {
    const inputs = [src("open-meteo", 30, 20, 0, "clear")]
    const predYes = {
      high: 30,
      low: 20,
      precip: 0,
      poP: 0,
      windBeaufort: 2,
      condition: "clear" as const,
    }
    expect(
      riskFlags(inputs, predYes).some(
        (f) => f.type === "diurnal" && f.level === "info"
      )
    ).toBe(true)

    const predNo = {
      high: 30,
      low: 20.1,
      precip: 0,
      poP: 0,
      windBeaufort: 2,
      condition: "clear" as const,
    }
    expect(riskFlags(inputs, predNo).some((f) => f.type === "diurnal")).toBe(
      false
    )
  })
})

describe("predict 全链路", () => {
  it("已知输入与权重产出确定值", () => {
    const inputs = [
      src("open-meteo", 33, 25, 8, "rain", 68, 4),
      src("openweather", 32, 26, 5, "rain", 70, 3),
      src("weatherapi", 31, 24, 0, "cloudy", 66, 5),
    ]
    const result = predict(inputs, W)
    // 高温 = 33×0.5+32×0.3+31×0.2 = 32.3
    expect(result.high).toBe(32.3)
    // 低温 = 25×0.5+26×0.3+24×0.2 = 25.1
    expect(result.low).toBe(25.1)
    // 降水概率 = 0.5+0.3 = 80%
    expect(result.poP).toBe(80)
    expect(result.precipLevel).toBe("light")
    // rain 0.8 vs cloudy 0.2
    expect(result.condition).toBe("rain")
    // 湿度 = 68×0.5+70×0.3+66×0.2 = 68.2
    expect(result.humidity).toBe(68.2)
    // 置信：rain 0.8 → high
    expect(result.confidence).toBe("high")
    // sourceInputs 保留每个源
    expect(Object.keys(result.sourceInputs)).toHaveLength(3)
  })

  it("某源缺湿度/风时跳过并归一", () => {
    const inputs = [
      src("open-meteo", 33, 25, 8, "rain", 68, 4),
      src("openweather", 32, 26, 5, "rain", null, null),
      src("weatherapi", 31, 24, 0, "cloudy", 66, 5),
    ]
    const result = predict(inputs, W)
    // 湿度仅 open-meteo(0.5)+weatherapi(0.2) 参与：(68×0.5+66×0.2)/0.7 = 67.4
    expect(result.humidity).toBe(67.4)
    // 风速同源归一：(4×0.5+5×0.2)/0.7 = 4.3
    expect(result.windMs).toBe(4.3)
    expect(result.windBeaufort).toBe(3)
  })

  it("条件缺失的源参与投票与置信", () => {
    const inputs = [
      src("open-meteo", 33, 25, 8, null, 68, 4),
      src("openweather", 32, 26, 5, "rain", 70, 3),
      src("weatherapi", 31, 24, 0, "cloudy", 66, 5),
    ]
    const result = predict(inputs, W)
    // 票：rain 0.3、cloudy 0.2 → rain
    expect(result.condition).toBe("rain")
    // 最大占比 0.3 → low
    expect(result.confidence).toBe("low")
  })

  it("接收带 detail 的权重表（回归：poP 曾为 NaN、result.weights 混入 detail）", () => {
    const inputs = [
      src("open-meteo", 33, 25, 8, "rain", 68, 4),
      src("openweather", 32, 26, 5, "rain", 70, 3),
      src("weatherapi", 31, 24, 0, "cloudy", 66, 5),
    ]
    const result = predict(inputs, WD)
    // 与 predict(inputs, W) 同结果：poP 80、置信 high、区间/湿度一致
    expect(result.poP).toBe(80)
    expect(result.confidence).toBe("high")
    expect(result.weights).toEqual(W)
    // detail 不得漏进 result.weights（提示词/卡片/落库都依赖它只含源权重）
    expect("detail" in result.weights).toBe(false)
  })

  it("权重表缺某源 → 该源权重按 0 计，不 NaN 且回填 0", () => {
    // 只给 open-meteo 权重：openweather/weatherapi 走 ?? 0（杀权重兜底突变）
    const inputs = [
      src("open-meteo", 30, 20, 2, "clear"),
      src("openweather", 32, 22, 2, "clear"),
      src("weatherapi", 34, 24, 2, "clear"),
    ]
    const result = predict(
      inputs,
      { "open-meteo": 0.5 } as unknown as Record<WeatherSource, number>
    )
    expect(result.high).toBe(30)
    expect(Number.isNaN(result.high)).toBe(false)
    expect(result.weights).toEqual({
      "open-meteo": 0.5,
      openweather: 0,
      weatherapi: 0,
    })
  })
})
