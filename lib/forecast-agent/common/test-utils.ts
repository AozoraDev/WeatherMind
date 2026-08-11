import { vi } from "vitest"

// —— 可链式 + thenable 的假 supabase ——
// 按 (table, 首个方法) 返回配置好的响应；支持 insert/update/delete/select/eq/neq/maybeSingle
// 与 `await supabase.from().select()` 直取两种形态；
// 额外把每次链式调用的 (table, method, args) 记进 `calls`，供断言查询参数与写入内容
export function fakeSupabase(
  handler: (
    table: string,
    first: "select" | "insert" | "update" | "delete"
  ) => Promise<unknown>
) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const makeQuery = (
    table: string,
    first: "select" | "insert" | "update" | "delete"
  ) => {
    const res = () => handler(table, first)
    const query = {
      select: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: "select", args })
        return query
      }),
      insert: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: "insert", args })
        return query
      }),
      update: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: "update", args })
        return query
      }),
      delete: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: "delete", args })
        return query
      }),
      eq: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: "eq", args })
        return query
      }),
      neq: vi.fn((...args: unknown[]) => {
        calls.push({ table, method: "neq", args })
        return query
      }),
      maybeSingle: vi.fn(async () => res()),
      then: (onF: (v: unknown) => unknown) => Promise.resolve(res()).then(onF),
    }
    return query
  }
  const supabase = {
    from: vi.fn((table: string) => ({
      select: (...args: unknown[]) =>
        makeQuery(table, "select").select(...args),
      insert: (...args: unknown[]) =>
        makeQuery(table, "insert").insert(...args),
      update: (...args: unknown[]) =>
        makeQuery(table, "update").update(...args),
      delete: (...args: unknown[]) =>
        makeQuery(table, "delete").delete(...args),
    })),
  }
  return { ...supabase, calls }
}

export const CITY = {
  id: "city-1",
  name_ja: "東京",
  name_en: "Tokyo",
  timezone: "Asia/Tokyo",
  is_active: true,
}

export const MODEL = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-1",
  model: "gpt-x",
}

export const PARAMS = {
  cityId: "city-1",
  email: "user@example.com",
  locale: "zh" as const,
  model: MODEL,
}

// 合法 AI 输出：无风险场景，不引用 risk_flags、不含温度单位
export const VALID_OUTPUT = {
  summary: "天气平稳，体感舒适，适合安排出行",
  points: [
    {
      metricId: "precipitation_probability",
      text: "降水概率较低，无需随身携带雨具",
    },
    { metricId: "predicted_high", text: "白天气温较为舒适" },
  ],
  advice: "早晚温差存在，出门可备一件薄外套",
}

// 双源当日/实时数据（全链路成功链路复用）
export const DAILY_TWO = [
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
    precipitation: 0,
    condition_category: "clear",
  },
]
export const CURRENT_TWO = [
  { source: "open-meteo", humidity: 60, wind_speed: 3 },
  { source: "openweather", humidity: 65, wind_speed: 4 },
]
