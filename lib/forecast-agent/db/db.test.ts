import { describe, expect, it } from "vitest"

import { toLocalDateKey } from "@/lib/weather/daily"

import {
  readForecast,
  readForecastForCity,
  isWithinRetryCooldown,
  claimPending,
  clearPredictions,
  buildSourceInputs,
  RETRY_COOLDOWN_MS,
} from "./db"
import { CITY, fakeSupabase } from "../common/test-utils"

describe("readForecast", () => {
  it("无行返回 null", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }))
    await expect(
      readForecast(supabase as never, "city-1", "2026-08-09", "zh")
    ).resolves.toBeNull()
  })

  it("有行原样返回", async () => {
    const row = { id: "r1", status: "success" as const, day: "2026-08-09" }
    const supabase = fakeSupabase(async () => ({ data: row, error: null }))
    const got = await readForecast(
      supabase as never,
      "city-1",
      "2026-08-09",
      "zh"
    )
    expect(got?.status).toBe("success")
  })

  it('查询参数正确：表名 / select("*") / eq 键（含 locale）', async () => {
    // 断言查询字符串字面量，杀表名/星号/列名字符串突变；locale 保证按语言读各自预测
    const supabase = fakeSupabase(async () => ({ data: null, error: null }))
    await readForecast(supabase as never, "city-1", "2026-08-09", "zh")
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "select",
      args: ["*"],
    })
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["city_id", "city-1"],
    })
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["day", "2026-08-09"],
    })
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["locale", "zh"],
    })
  })
})

describe("readForecastForCity", () => {
  it("城市存在 → 按城市时区算本地日读回行", async () => {
    const row = { id: "r1", status: "success" as const, day: "2026-08-09" }
    const handler = async (table: string) => {
      if (table === "cities") return { data: CITY, error: null }
      return { data: row, error: null }
    }
    const supabase = fakeSupabase(handler)
    const got = await readForecastForCity(supabase as never, "city-1", "zh")
    expect(got?.status).toBe("success")
    // 城市查询参数：表名/select/eq 键与 is_active 过滤（杀表名/列名字符串与布尔突变）
    expect(supabase.calls).toContainEqual({
      table: "cities",
      method: "select",
      args: ["*"],
    })
    expect(supabase.calls).toContainEqual({
      table: "cities",
      method: "eq",
      args: ["id", "city-1"],
    })
    expect(supabase.calls).toContainEqual({
      table: "cities",
      method: "eq",
      args: ["is_active", true],
    })
    // day 由城市时区实时算（服务端定日，防客户端时区漂移）
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["day", toLocalDateKey(new Date().toISOString(), "Asia/Tokyo")],
    })
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["locale", "zh"],
    })
  })

  it("城市不存在/不活跃 → null，不再查预测表", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }))
    await expect(
      readForecastForCity(supabase as never, "city-x", "zh")
    ).resolves.toBeNull()
    // 城市查询失败即返回，不该再往预测表发查询
    expect(
      supabase.calls.some((c) => c.table === "forecast_agent_predictions")
    ).toBe(false)
  })
})

describe("isWithinRetryCooldown", () => {
  const now = Date.UTC(2026, 7, 11, 12, 0, 0) // 2026-08-11 12:00 UTC

  it("failed_at 缺失 → 不冷却", () => {
    expect(isWithinRetryCooldown(null, now)).toBe(false)
  })

  it("距失败 <5 分钟 → 冷却中", () => {
    const t = new Date(now - (RETRY_COOLDOWN_MS - 1000)).toISOString()
    expect(isWithinRetryCooldown(t, now)).toBe(true)
  })

  it("距失败恰 ≥5 分钟 → 已出冷却", () => {
    const t = new Date(now - RETRY_COOLDOWN_MS).toISOString()
    expect(isWithinRetryCooldown(t, now)).toBe(false)
  })
})

describe("clearPredictions", () => {
  it("删除整表：delete + 恒假 uuid 过滤（杀表名/方法/哨兵字符串突变）", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: null }))
    await expect(clearPredictions(supabase as never)).resolves.toBe(true)
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "delete",
      args: [],
    })
    expect(supabase.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "neq",
      args: ["id", "00000000-0000-0000-0000-000000000000"],
    })
  })

  it("删除失败 → false", async () => {
    const supabase = fakeSupabase(async () => ({
      data: null,
      error: { message: "boom" },
    }))
    await expect(clearPredictions(supabase as never)).resolves.toBe(false)
  })
})

describe("claimPending 重试清冷却", () => {
  it("读回 failed 行 → 转回 pending 并清 failed_at/error_code", async () => {
    const existing = {
      id: "old",
      status: "failed" as const,
      failed_at: "2026-08-11T00:00:00Z",
      error_code: "provider",
    }
    const handler = async (table: string, first: string) => {
      if (table === "forecast_agent_predictions") {
        if (first === "insert") return { data: null, error: { code: "23505" } }
        if (first === "select") return { data: existing, error: null }
        if (first === "update")
          return { data: { ...existing, status: "pending" as const }, error: null }
      }
      return { data: null, error: null }
    }
    const service = fakeSupabase(handler)
    const res = await claimPending(
      service as never,
      "city-1",
      "2026-08-11",
      "zh",
      "user@example.com"
    )
    expect(res?.claimed).toBe(true)
    // 转 pending 时同步清 failed_at，冷却计时归零
    const update = service.calls.find(
      (c) => c.method === "update"
    )?.args[0] as Record<string, unknown>
    expect(update).toMatchObject({
      status: "pending",
      error_code: null,
      failed_at: null,
    })
    // 认领参数：唯一键 城×日×语言 + pending + 创建人（杀 insert 对象/状态串突变）
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "insert",
      args: [
        {
          city_id: "city-1",
          day: "2026-08-11",
          locale: "zh",
          status: "pending",
          created_by: "user@example.com",
        },
      ],
    })
    // 23505 冲突后按 城×日×语言 回读既有行（杀回读查询表名/列名突变）
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "select",
      args: ["*"],
    })
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["city_id", "city-1"],
    })
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["day", "2026-08-11"],
    })
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["locale", "zh"],
    })
    // 重试认领按 id 更新（杀更新过滤键字符串突变）
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["id", "old"],
    })
  })

  it("insert 非冲突错误（非 23505）→ 返回 null，不再回读", async () => {
    const handler = async (table: string, first: string) => {
      if (table === "forecast_agent_predictions" && first === "insert")
        return { data: null, error: { code: "42P01" } }
      return { data: null, error: null }
    }
    const service = fakeSupabase(handler)
    await expect(
      claimPending(service as never, "city-1", "2026-08-11", "zh", "u@e.com")
    ).resolves.toBeNull()
    // 真实错误直接失败，不再按 23505 回读既有行（insert 链自带 .select()，只看 select("*")）
    expect(
      service.calls.some((c) => c.method === "select" && c.args[0] === "*")
    ).toBe(false)
  })

  it("23505 后读回无行 → 返回 null", async () => {
    const handler = async (table: string, first: string) => {
      if (table === "forecast_agent_predictions") {
        if (first === "insert") return { data: null, error: { code: "23505" } }
        if (first === "select") return { data: null, error: null }
      }
      return { data: null, error: null }
    }
    const service = fakeSupabase(handler)
    await expect(
      claimPending(service as never, "city-1", "2026-08-11", "zh", "u@e.com")
    ).resolves.toBeNull()
  })

  it("failed 行重试时更新不返回行 → 返回 null（不假装已认领）", async () => {
    const existing = { id: "old", status: "failed" as const }
    const handler = async (table: string, first: string) => {
      if (table === "forecast_agent_predictions") {
        if (first === "insert") return { data: null, error: { code: "23505" } }
        if (first === "select") return { data: existing, error: null }
        if (first === "update") return { data: null, error: null }
      }
      return { data: null, error: null }
    }
    const service = fakeSupabase(handler)
    await expect(
      claimPending(service as never, "city-1", "2026-08-11", "zh", "u@e.com")
    ).resolves.toBeNull()
  })
})

describe("buildSourceInputs", () => {
  it("按 城×日 并行查 daily 与 current（表名/列名/过滤键断言）", async () => {
    const supabase = fakeSupabase(async () => ({ data: [], error: null }))
    await buildSourceInputs(supabase as never, "city-1", "2026-08-09")
    expect(supabase.calls).toContainEqual({
      table: "weather_daily",
      method: "select",
      args: ["*"],
    })
    expect(supabase.calls).toContainEqual({
      table: "weather_daily",
      method: "eq",
      args: ["city_id", "city-1"],
    })
    expect(supabase.calls).toContainEqual({
      table: "weather_daily",
      method: "eq",
      args: ["day", "2026-08-09"],
    })
    expect(supabase.calls).toContainEqual({
      table: "weather_current",
      method: "select",
      args: ["*"],
    })
    expect(supabase.calls).toContainEqual({
      table: "weather_current",
      method: "eq",
      args: ["city_id", "city-1"],
    })
  })

  it("合法条件透传；湿度/风取当日 current 快照，缺快照兜底 null", async () => {
    const daily = [
      {
        source: "open-meteo",
        high_temp: 30,
        low_temp: 22,
        precipitation: 0,
        condition_category: "clear",
      },
      {
        source: "openweather",
        high_temp: 31,
        low_temp: 23,
        precipitation: 5,
        condition_category: "rain",
      },
    ]
    // openweather 无 current 快照 → 湿度/风兜底 null（集成跳过该维）
    const current = [{ source: "open-meteo", humidity: 60, wind_speed: 3 }]
    const handler = async (table: string) => {
      if (table === "weather_daily") return { data: daily, error: null }
      if (table === "weather_current") return { data: current, error: null }
      return { data: [], error: null }
    }
    const supabase = fakeSupabase(handler)
    const inputs = await buildSourceInputs(
      supabase as never,
      "city-1",
      "2026-08-09"
    )
    expect(inputs).toEqual([
      {
        source: "open-meteo",
        high: 30,
        low: 22,
        precip: 0,
        condition: "clear",
        humidity: 60,
        windMs: 3,
      },
      {
        source: "openweather",
        high: 31,
        low: 23,
        precip: 5,
        condition: "rain",
        humidity: null,
        windMs: null,
      },
    ])
  })

  it("非法条件分类归 null（不参与投票）；无 daily 行 → 空数组", async () => {
    const daily = [
      {
        source: "open-meteo",
        high_temp: 30,
        low_temp: 22,
        precipitation: 0,
        condition_category: "bizarre",
      },
    ]
    const handler = async (table: string) => {
      if (table === "weather_daily") return { data: daily, error: null }
      if (table === "weather_current")
        return {
          data: [{ source: "open-meteo", humidity: null, wind_speed: null }],
          error: null,
        }
      return { data: [], error: null }
    }
    const supabase = fakeSupabase(handler)
    const inputs = await buildSourceInputs(
      supabase as never,
      "city-1",
      "2026-08-09"
    )
    expect(inputs).toEqual([
      {
        source: "open-meteo",
        high: 30,
        low: 22,
        precip: 0,
        condition: null,
        humidity: null,
        windMs: null,
      },
    ])
    // 无 daily 行 → 空数组
    const empty = fakeSupabase(async () => ({ data: [], error: null }))
    await expect(
      buildSourceInputs(empty as never, "city-1", "2026-08-09")
    ).resolves.toEqual([])
  })
})
