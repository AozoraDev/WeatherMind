import { describe, expect, it } from "vitest"

import {
  conditionCategorySchema,
  forecastItemSchema,
  normalizedWeatherSchema,
  sourceSchema,
  weatherPointSchema,
} from "./weather"

// 合法 WeatherPoint 样例，各测试在此之上做增减
const validPoint = {
  temperature: 25,
  feelsLike: 26,
  humidity: 60,
  pressure: 1013,
  windSpeed: 3.5,
  windDirection: 180,
  precipitation: 0,
  conditionCode: 800,
  conditionLabel: "Clear",
  conditionCategory: "clear",
  observedAt: "2026-08-06T00:00:00.000Z",
}

// 剔除指定字段，构造「缺字段」场景（避免解构触发 no-unused-vars）
function withoutKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  const copy = { ...obj }
  delete (copy as Record<string, unknown>)[key]
  return copy
}

// 断言 safeParse 失败且指定路径缺字段/类型不符
function expectFail(
  result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } },
  path: string
) {
  expect(result.success).toBe(false)
  expect(result.error?.issues.some((i) => i.path.join(".") === path)).toBe(true)
}

describe("weatherPointSchema", () => {
  it("完整合法对象通过", () => {
    expect(weatherPointSchema.safeParse(validPoint).success).toBe(true)
  })

  it("可选字段可缺省", () => {
    expect(
      weatherPointSchema.safeParse(
        withoutKey(
          withoutKey(
            withoutKey(withoutKey(validPoint, "feelsLike"), "humidity"),
            "pressure"
          ),
          "windDirection"
        )
      ).success
    ).toBe(true)
  })

  it("缺 temperature 拒绝", () => {
    expectFail(
      weatherPointSchema.safeParse(withoutKey(validPoint, "temperature")),
      "temperature"
    )
  })

  it("缺 windSpeed 拒绝", () => {
    expectFail(
      weatherPointSchema.safeParse(withoutKey(validPoint, "windSpeed")),
      "windSpeed"
    )
  })

  it("缺 observedAt 拒绝", () => {
    expectFail(
      weatherPointSchema.safeParse(withoutKey(validPoint, "observedAt")),
      "observedAt"
    )
  })

  it("温度类型错误拒绝", () => {
    expectFail(
      weatherPointSchema.safeParse({ ...validPoint, temperature: "30" }),
      "temperature"
    )
  })
})

describe("conditionCategorySchema", () => {
  it("合法分类通过", () => {
    expect(conditionCategorySchema.safeParse("rain").success).toBe(true)
  })

  it("未知分类拒绝", () => {
    expect(conditionCategorySchema.safeParse("sunny").success).toBe(false)
  })
})

describe("sourceSchema", () => {
  it("三个合法源通过", () => {
    for (const s of ["open-meteo", "openweather", "weatherapi"]) {
      expect(sourceSchema.safeParse(s).success).toBe(true)
    }
  })

  it("未知源拒绝", () => {
    expect(sourceSchema.safeParse("open-weather").success).toBe(false)
  })
})

describe("forecastItemSchema", () => {
  it("带 forecastTime 通过", () => {
    expect(
      forecastItemSchema.safeParse({
        ...validPoint,
        forecastTime: "2026-08-06T03:00:00.000Z",
      }).success
    ).toBe(true)
  })

  it("缺 forecastTime 拒绝", () => {
    expectFail(forecastItemSchema.safeParse(validPoint), "forecastTime")
  })
})

describe("normalizedWeatherSchema", () => {
  const valid = {
    city: {
      id: "c1",
      nameJa: "東京",
      nameEn: "Tokyo",
      latitude: 35.6762,
      longitude: 139.6503,
      timezone: "Asia/Tokyo",
    },
    source: "open-meteo",
    current: validPoint,
    forecast: [
      { ...validPoint, forecastTime: "2026-08-06T03:00:00.000Z" },
      { ...validPoint, forecastTime: "2026-08-06T06:00:00.000Z" },
    ],
    fetchedAt: "2026-08-06T00:00:00.000Z",
    raw: { whatever: true },
  }

  it("完整合法对象通过", () => {
    expect(normalizedWeatherSchema.safeParse(valid).success).toBe(true)
  })

  it("未知 source 拒绝", () => {
    expect(
      normalizedWeatherSchema.safeParse({ ...valid, source: "nasa" }).success
    ).toBe(false)
  })
})
