import { describe, expect, it } from "vitest"

import { providers } from "./index"
import { openMeteo } from "./open-meteo"
import { openWeather } from "./openweather"
import { weatherApi } from "./weatherapi"

// 注册表：pipeline 按序遍历三源，顺序即回退优先级
describe("providers 注册表", () => {
  it("按 Open-Meteo → OpenWeather → WeatherAPI 顺序注册三源", () => {
    expect(providers.map((p) => p.source)).toEqual([
      "open-meteo",
      "openweather",
      "weatherapi",
    ])
  })

  it("元素即各 adapter 实例（同一对象引用）", () => {
    expect(providers).toContain(openMeteo)
    expect(providers).toContain(openWeather)
    expect(providers).toContain(weatherApi)
  })

  it("每源都实现 fetchCurrentAndForecast 与 fetchDailyHistory 契约", () => {
    for (const p of providers) {
      expect(typeof p.fetchCurrentAndForecast).toBe("function")
      expect(typeof p.fetchDailyHistory).toBe("function")
    }
  })
})
