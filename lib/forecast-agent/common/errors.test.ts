import { describe, expect, it } from "vitest"

import { FORECAST_ERROR_CODES, isForecastErrorCode } from "./errors"

// 预报错误码守卫：UI 取 i18n 文案前过滤非法码，防御外部 error_code 漂移落到缺失键。
// 已知码集合固定（外部契约），用全量断言兜住增删
describe("FORECAST_ERROR_CODES", () => {
  it("已知错误码全部收录，顺序稳定", () => {
    expect([...FORECAST_ERROR_CODES]).toEqual([
      "no-model",
      "retry-cooldown",
      "insufficient-data",
      "provider",
      "parse",
      "consistency",
      "react-loop",
      "generic",
    ])
  })
})

describe("isForecastErrorCode", () => {
  it("已知错误码 → true", () => {
    expect(isForecastErrorCode("no-model")).toBe(true)
    expect(isForecastErrorCode("retry-cooldown")).toBe(true)
    expect(isForecastErrorCode("provider")).toBe(true)
    expect(isForecastErrorCode("generic")).toBe(true)
  })

  it("非法错误码 / 空串 / 非字符串 → false", () => {
    expect(isForecastErrorCode("unknown")).toBe(false)
    expect(isForecastErrorCode("")).toBe(false)
    expect(isForecastErrorCode(null)).toBe(false)
    expect(isForecastErrorCode(undefined)).toBe(false)
  })
})
