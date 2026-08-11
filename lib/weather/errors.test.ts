import { describe, expect, it } from "vitest"

import { CityError, WeatherError } from "./errors"

// 受限错误码类：构造时把 code 记为 message（供 mutation.error.code 取 i18n 文案）与 name
describe("WeatherError", () => {
  it("构造时记录受限错误码与 name", () => {
    const err = new WeatherError("unauthorized")
    expect(err.code).toBe("unauthorized")
    expect(err.name).toBe("WeatherError")
    expect(err.message).toBe("unauthorized")
  })

  it("是 Error 实例，可被 instanceof 判断", () => {
    expect(new WeatherError("generic")).toBeInstanceOf(Error)
  })
})

describe("CityError", () => {
  it("构造时记录城市增删受限错误码与 name", () => {
    const err = new CityError("duplicate")
    expect(err.code).toBe("duplicate")
    expect(err.name).toBe("CityError")
    expect(err.message).toBe("duplicate")
  })
})
