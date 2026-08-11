import { describe, expect, it, vi } from "vitest"

import {
  blendParams,
  blendWeights,
  computeMae,
  computeWeights,
  consistencyScore,
  median,
  PRIOR,
  scoreConsistency,
  truthMae,
} from "./weights"

describe("median", () => {
  it("奇数取中间值", () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it("偶数取中间两数平均", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it("空数组返回 0", () => {
    expect(median([])).toBe(0)
  })
})

describe("scoreConsistency（留一法偏离度）", () => {
  it("三源完全一致 → 全 0 偏离", () => {
    const rows = [
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 30,
      },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "openweather" as const,
        high_temp: 30,
      },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "weatherapi" as const,
        high_temp: 30,
      },
    ]
    const score = scoreConsistency(rows)
    expect(score["open-meteo"]).toBe(0)
    expect(score.openweather).toBe(0)
    expect(score.weatherapi).toBe(0)
  })

  it("某源总跑偏 → 偏离度高于其余", () => {
    const rows = [
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 30,
      },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "openweather" as const,
        high_temp: 30,
      },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "weatherapi" as const,
        high_temp: 20,
      },
      {
        city_id: "c1",
        day: "2026-08-02",
        source: "open-meteo" as const,
        high_temp: 31,
      },
      {
        city_id: "c1",
        day: "2026-08-02",
        source: "openweather" as const,
        high_temp: 31,
      },
      {
        city_id: "c1",
        day: "2026-08-02",
        source: "weatherapi" as const,
        high_temp: 21,
      },
    ]
    const score = scoreConsistency(rows)
    // weatherapi 每次偏「另两源中位数」10°（[30,30]→30）；open-meteo 的中位对照含 outlier（[30,20]→25）→ 偏 5°
    // 留一法在只有 3 源时「好源」也会沾上 outlier，但跑偏者依然分最高
    expect(score.weatherapi).toBe(10)
    expect(score["open-meteo"]).toBe(5)
    expect(score.weatherapi).toBeGreaterThan(score["open-meteo"]!)
  })

  it("单独一天无对照的源不计分（count 为 0 → 该源无样本）", () => {
    const rows = [
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 30,
      },
    ]
    expect(scoreConsistency(rows)["open-meteo"]).toBeUndefined()
  })

  it("不同城市同一天按 城×日 分组，互不干扰", () => {
    // 两城各自对照：om 每城偏 [30,20] 中位数 25 → 5°，两城平均仍 5°
    // 若误把所有行并成一组，om 的中位数对照混入跨城值 [30,20,50,40] 中位数 35 → 平均 10°
    const rows = [
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 30,
      },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "openweather" as const,
        high_temp: 30,
      },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "weatherapi" as const,
        high_temp: 20,
      },
      {
        city_id: "c2",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 50,
      },
      {
        city_id: "c2",
        day: "2026-08-01",
        source: "openweather" as const,
        high_temp: 50,
      },
      {
        city_id: "c2",
        day: "2026-08-01",
        source: "weatherapi" as const,
        high_temp: 40,
      },
    ]
    const score = scoreConsistency(rows)
    expect(score["open-meteo"]).toBe(5)
    expect(score.weatherapi).toBe(10)
  })
})

describe("computeMae", () => {
  it("无真值行 → 无样本返回 undefined", () => {
    const { mae, truthDays } = computeMae([], [])
    expect(mae["open-meteo"]).toBeUndefined()
    expect(truthDays).toBe(0)
  })

  it("逐源计算平均绝对误差，真值天数为参与对账的 城×日 数", () => {
    const truth = [
      { city_id: "c1", day: "2026-08-01", observed_high: 30 },
      { city_id: "c1", day: "2026-08-02", observed_high: 32 },
    ]
    const daily = [
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 28,
      },
      {
        city_id: "c1",
        day: "2026-08-02",
        source: "open-meteo" as const,
        high_temp: 34,
      },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "openweather" as const,
        high_temp: 30,
      },
    ]
    const { mae, truthDays } = computeMae(truth, daily)
    // open-meteo 误差 2 + 2 → MAE 2；openweather 误差 0 → MAE 0
    expect(mae["open-meteo"]).toBe(2)
    expect(mae.openweather).toBe(0)
    // 参与对账的 城×日：c1:08-01 与 c1:08-02（openweather 只占 08-01，天数按行对账键去重）
    expect(truthDays).toBe(2)
  })

  it("无真值对照的 daily 行被跳过，不计天数与误差", () => {
    // c2 无真值：正常应跳过 → 只有 c1 参与，MAE 2、truthDays 1
    const truth = [{ city_id: "c1", day: "2026-08-01", observed_high: 30 }]
    const daily = [
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 28,
      },
      {
        city_id: "c2",
        day: "2026-08-01",
        source: "open-meteo" as const,
        high_temp: 20,
      },
    ]
    const { mae, truthDays } = computeMae(truth, daily)
    expect(mae["open-meteo"]).toBe(2)
    expect(truthDays).toBe(1)
  })

  it("weatherapi 有对账样本 → 正常出 MAE（acc 初始化需包含三源）", () => {
    const truth = [{ city_id: "c1", day: "2026-08-01", observed_high: 30 }]
    const daily = [
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "weatherapi" as const,
        high_temp: 25,
      },
    ]
    const { mae } = computeMae(truth, daily)
    expect(mae.weatherapi).toBe(5)
  })
})

describe("blendParams", () => {
  it("真值 <7 天：先验主导", () => {
    expect(blendParams(0)).toEqual({ alpha: 0.7, beta: 0.3, gamma: 0 })
  })

  it("7-29 天：MAE 过半", () => {
    expect(blendParams(14)).toEqual({ alpha: 0.3, beta: 0.2, gamma: 0.5 })
  })

  it("≥30 天：MAE 主导", () => {
    expect(blendParams(60)).toEqual({ alpha: 0.1, beta: 0.1, gamma: 0.8 })
  })

  it.each([
    [0, { alpha: 0.7, beta: 0.3, gamma: 0 }],
    [6, { alpha: 0.7, beta: 0.3, gamma: 0 }],
    [7, { alpha: 0.3, beta: 0.2, gamma: 0.5 }],
    [29, { alpha: 0.3, beta: 0.2, gamma: 0.5 }],
    [30, { alpha: 0.1, beta: 0.1, gamma: 0.8 }],
    [31, { alpha: 0.1, beta: 0.1, gamma: 0.8 }],
    [100, { alpha: 0.1, beta: 0.1, gamma: 0.8 }],
  ])("档位边界：truthDays=%i", (days, expected) => {
    // 掐住 ≥30 与 ≥7 的临界点，防止比较符被改成 > 后边界错档
    expect(blendParams(days)).toEqual(expected)
  })
})

describe("blendWeights", () => {
  it("真值 0 天（无样本）时权重 = 先验归一", () => {
    // 无任何采样 → consistency/mae 均 {}，各源回退先验 → 合成即先验
    const w = blendWeights(0, PRIOR, {}, {})
    expect(w["open-meteo"]).toBeCloseTo(0.5)
    expect(w.openweather).toBeCloseTo(0.3)
    expect(w.weatherapi).toBeCloseTo(0.2)
  })

  it("某源一致性差 → 权重被压低", () => {
    const cons = { "open-meteo": 0, openweather: 0, weatherapi: 9 }
    const w = blendWeights(0, PRIOR, cons, {})
    // weatherapi 一致性分 9 → 1/(1+9)=0.1，被压低到先验(0.2)以下，且低于其余两源
    expect(w.weatherapi).toBeLessThan(0.2)
    expect(w.weatherapi).toBeLessThan(w["open-meteo"])
    expect(w["open-meteo"]).toBeGreaterThan(w.openweather)
  })

  it("带 detail 快照", () => {
    const w = blendWeights(0, PRIOR, {}, {})
    expect(w.detail).toMatchObject({ alpha: 0.7, beta: 0.3, gamma: 0 })
  })

  it("MAE 有样本且真值≥30 天：MAE 主导并归一", () => {
    const mae = { "open-meteo": 0, openweather: 1, weatherapi: 9 }
    const w = blendWeights(30, PRIOR, {}, mae)
    // α=0.1,β=0.1,γ=0.8：om raw=0.1*0.5+0.1*0.5+0.8*1=0.9；ow raw=0.1*0.3+0.1*0.3+0.8*0.5=0.46；wa raw=0.1*0.2+0.1*0.2+0.8*0.1=0.12 → 总 1.48
    expect(w["open-meteo"]).toBeCloseTo(0.9 / 1.48, 3)
    expect(w.openweather).toBeCloseTo(0.46 / 1.48, 3)
    expect(w.weatherapi).toBeCloseTo(0.12 / 1.48, 3)
    expect(w["open-meteo"] + w.openweather + w.weatherapi).toBeCloseTo(1, 3)
  })

  it("一致性有样本时按 1/(1+dev) 精确折算", () => {
    const w = blendWeights(0, PRIOR, { "open-meteo": 1 }, {})
    // om cons=1/(1+1)=0.5 → raw om=0.7*0.5+0.3*0.5=0.5；ow/wa 无样本回退先验 → raw 0.3/0.2；总恰为 1
    expect(w["open-meteo"]).toBeCloseTo(0.5, 3)
    expect(w.openweather).toBeCloseTo(0.3, 3)
    expect(w.weatherapi).toBeCloseTo(0.2, 3)
  })

  it("raw 总和 ≠1 时归一化到 1（total 兜底/除法被改都会破坏）", () => {
    const w = blendWeights(0, PRIOR, { "open-meteo": 0.5 }, {})
    // om cons=1/1.5=0.6667 → raw om=0.7*0.5+0.3*0.6667=0.55；ow/wa raw=0.3/0.2 → 总 1.05
    expect(w["open-meteo"]).toBeCloseTo(0.55 / 1.05, 3)
    expect(w.openweather).toBeCloseTo(0.3 / 1.05, 3)
    expect(w.weatherapi).toBeCloseTo(0.2 / 1.05, 3)
    expect(w["open-meteo"] + w.openweather + w.weatherapi).toBeCloseTo(1, 3)
  })

  it("先验全 0 且无样本：total 用 || 1 兜底，不除零", () => {
    const w = blendWeights(
      0,
      { "open-meteo": 0, openweather: 0, weatherapi: 0 },
      {},
      {}
    )
    expect(Number.isNaN(w["open-meteo"])).toBe(false)
    expect(w["open-meteo"]).toBe(0)
    expect(w.openweather).toBe(0)
    expect(w.weatherapi).toBe(0)
  })

  it("detail 返回 prior/consistency/mae 原值", () => {
    const cons = { "open-meteo": 0.5 }
    const mae = { openweather: 2 }
    const w = blendWeights(14, PRIOR, cons, mae)
    expect(w.detail).toEqual({
      alpha: 0.3,
      beta: 0.2,
      gamma: 0.5,
      prior: PRIOR,
      consistency: cons,
      mae,
    })
  })
})

describe("consistencyScore / truthMae / computeWeights（mock supabase）", () => {
  // 构造可 thenable 且带 gte/lte 链的假查询对象
  function makeQuery(data: unknown) {
    const q = {
      gte: vi.fn(() => q),
      lte: vi.fn(() => q),
      then: (onF: (v: unknown) => unknown, onR: (v: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(onF, onR),
    }
    return q
  }
  function fakeSupabase(byTable: (t: string) => unknown) {
    return {
      from: vi.fn((t: string) => ({
        select: vi.fn(() => makeQuery(byTable(t))),
      })),
    } as unknown as Parameters<typeof consistencyScore>[0]
  }

  // 记录查询链参数（select/gte/lte）的假客户端，便于精确断言日期窗口与 select 列
  function fakeSupabaseRecording(byTable: (t: string) => unknown) {
    const queries: Record<
      string,
      { select: unknown; gte?: [unknown, unknown]; lte?: [unknown, unknown] }
    > = {}
    const supabase = {
      from: vi.fn((t: string) => ({
        select: vi.fn((cols: unknown) => {
          queries[t] = { select: cols }
          const q = {
            gte: vi.fn((a: unknown, b: unknown) => {
              queries[t]!.gte = [a, b]
              return q
            }),
            lte: vi.fn((a: unknown, b: unknown) => {
              queries[t]!.lte = [a, b]
              return q
            }),
            then: (onF: (v: unknown) => unknown) =>
              Promise.resolve({ data: byTable(t), error: null }).then(onF),
          }
          return q
        }),
      })),
    } as unknown as Parameters<typeof consistencyScore>[0]
    return { supabase, queries }
  }

  it("consistencyScore 查询窗口并计算", async () => {
    const daily = [
      { city_id: "c1", day: "2026-08-01", source: "open-meteo", high_temp: 30 },
      {
        city_id: "c1",
        day: "2026-08-01",
        source: "openweather",
        high_temp: 30,
      },
      { city_id: "c1", day: "2026-08-01", source: "weatherapi", high_temp: 20 },
    ]
    const supabase = fakeSupabase((t) => (t === "weather_daily" ? daily : []))
    const score = await consistencyScore(
      supabase,
      new Date("2026-08-07T00:00:00Z")
    )
    expect(score.weatherapi).toBe(10)
  })

  it("查询失败回退空（无样本，blend 回退先验）", async () => {
    const q = {
      gte: vi.fn(() => q),
      lte: vi.fn(() => q),
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: "boom" } }).then(onF),
    }
    const supabase = {
      from: vi.fn(() => ({ select: vi.fn(() => q) })),
    } as unknown as Parameters<typeof consistencyScore>[0]
    const score = await consistencyScore(supabase)
    expect(score["open-meteo"]).toBeUndefined()
  })

  it("truthMae 并行两表查询", async () => {
    const truth = [
      { city_id: "c1", day: "2026-08-01", observed_high: 30 },
      { city_id: "c1", day: "2026-08-02", observed_high: 32 },
    ]
    const daily = [
      { city_id: "c1", day: "2026-08-01", source: "open-meteo", high_temp: 28 },
      { city_id: "c1", day: "2026-08-02", source: "open-meteo", high_temp: 34 },
    ]
    const supabase = fakeSupabase((t) =>
      t === "weather_truth" ? truth : t === "weather_daily" ? daily : []
    )
    const { mae, truthDays } = await truthMae(supabase)
    expect(mae["open-meteo"]).toBe(2)
    expect(truthDays).toBe(2)
  })

  it("computeWeights 串通：真值 0 天时以先验为主", async () => {
    const supabase = fakeSupabase(() => [])
    const w = await computeWeights(supabase)
    expect(w.detail.alpha).toBe(0.7)
    expect(w["open-meteo"]).toBeCloseTo(0.5, 1)
  })

  it("consistencyScore 精确断言查询窗口与参数", async () => {
    // now=08-07、days=6 → from=08-02、to=08-07；toUtcDateKey 仅取 YYYY-MM-DD
    const daily = [
      { city_id: "c1", day: "2026-08-02", source: "open-meteo", high_temp: 30 },
      {
        city_id: "c1",
        day: "2026-08-02",
        source: "openweather",
        high_temp: 30,
      },
      { city_id: "c1", day: "2026-08-02", source: "weatherapi", high_temp: 20 },
    ]
    const { supabase, queries } = fakeSupabaseRecording((t) =>
      t === "weather_daily" ? daily : []
    )
    const score = await consistencyScore(
      supabase,
      new Date("2026-08-07T00:00:00Z"),
      6
    )
    expect(score.weatherapi).toBe(10)
    const dq = queries["weather_daily"]!
    expect(dq.select).toBe("city_id, day, source, high_temp")
    expect(dq.gte).toEqual(["day", "2026-08-02"])
    expect(dq.lte).toEqual(["day", "2026-08-07"])
  })

  it("consistencyScore 窗口边界按东京日期键（JST 00:00 不落前一天）", async () => {
    // now=08-07T15:00Z = JST 08-08 00:00；若按 UTC 日期键会取成 08-07、漏掉当天行，
    // 窗口上下界必须按 JST 取 08-08（当天行已由 JST 午夜采集落库）
    const daily = [
      { city_id: "c1", day: "2026-08-08", source: "open-meteo", high_temp: 30 },
      {
        city_id: "c1",
        day: "2026-08-08",
        source: "openweather",
        high_temp: 30,
      },
      { city_id: "c1", day: "2026-08-08", source: "weatherapi", high_temp: 20 },
    ]
    const { supabase, queries } = fakeSupabaseRecording((t) =>
      t === "weather_daily" ? daily : []
    )
    const score = await consistencyScore(
      supabase,
      new Date("2026-08-07T15:00:00Z"),
      6
    )
    expect(score.weatherapi).toBe(10) // 08-08 当天行在窗口内才参与一致性计算
    const dq = queries["weather_daily"]!
    expect(dq.gte).toEqual(["day", "2026-08-03"])
    expect(dq.lte).toEqual(["day", "2026-08-08"])
  })

  it("consistencyScore 数据为空且无错误 → 空结果不抛错", async () => {
    // error 为 null 但 data 也为 null：error||!data 才应短路返回 {}
    const supabase = fakeSupabase(() => null)
    const score = await consistencyScore(supabase)
    expect(score).toEqual({})
  })

  it("truthMae 两表 select 列精确断言", async () => {
    const truth = [{ city_id: "c1", day: "2026-08-01", observed_high: 30 }]
    const daily = [
      { city_id: "c1", day: "2026-08-01", source: "open-meteo", high_temp: 28 },
    ]
    const { supabase, queries } = fakeSupabaseRecording((t) =>
      t === "weather_truth" ? truth : t === "weather_daily" ? daily : []
    )
    const { mae, truthDays } = await truthMae(supabase)
    expect(queries["weather_truth"]!.select).toBe("city_id, day, observed_high")
    expect(queries["weather_daily"]!.select).toBe(
      "city_id, day, source, high_temp"
    )
    expect(mae["open-meteo"]).toBe(2)
    expect(truthDays).toBe(1)
  })

  it("truthMae 查询窗口按东京日期键限定", async () => {
    // now=08-07、days=31 → from=07-08、to=08-07（与 consistencyScore 同口径）
    const truth = [{ city_id: "c1", day: "2026-08-01", observed_high: 30 }]
    const daily = [
      { city_id: "c1", day: "2026-08-01", source: "open-meteo", high_temp: 28 },
    ]
    const { supabase, queries } = fakeSupabaseRecording((t) =>
      t === "weather_truth" ? truth : t === "weather_daily" ? daily : []
    )
    const { mae } = await truthMae(supabase, new Date("2026-08-07T00:00:00Z"), 31)
    expect(mae["open-meteo"]).toBe(2)
    expect(queries["weather_truth"]!.gte).toEqual(["day", "2026-07-08"])
    expect(queries["weather_truth"]!.lte).toEqual(["day", "2026-08-07"])
    expect(queries["weather_daily"]!.gte).toEqual(["day", "2026-07-08"])
    expect(queries["weather_daily"]!.lte).toEqual(["day", "2026-08-07"])
  })

  it("truthMae 真值表出错（error 有值）→ 空结果 mae {} 且 truthDays 0", async () => {
    const truth = [{ city_id: "c1", day: "2026-08-01", observed_high: 30 }]
    const daily = [
      { city_id: "c1", day: "2026-08-01", source: "open-meteo", high_temp: 28 },
    ]
    const qErr = {
      gte: vi.fn(() => qErr),
      lte: vi.fn(() => qErr),
      then: (onF: (v: unknown) => unknown) =>
        Promise.resolve({ data: truth, error: { message: "boom" } }).then(onF),
    }
    const supabase = {
      from: vi.fn((t: string) => ({
        select: vi.fn(() => (t === "weather_truth" ? qErr : makeQuery(daily))),
      })),
    } as unknown as Parameters<typeof consistencyScore>[0]
    const { mae, truthDays } = await truthMae(supabase)
    // error 存在即应整体返回空，即使 data 里其实有真值
    expect(mae).toEqual({})
    expect(truthDays).toBe(0)
  })
})
