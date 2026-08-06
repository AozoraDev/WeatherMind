import { describe, expect, it } from "vitest"

import { createCitySchema, deleteCitySchema } from "./city"

// 断言 safeParse 失败且指定路径的校验 message 符合预期
function expectMessage(
  result: {
    success: boolean
    error?: { issues: { path: PropertyKey[]; message: string }[] }
  },
  path: string,
  message: string
) {
  expect(result.success).toBe(false)
  expect(
    result.error?.issues.find((i) => i.path.join(".") === path)?.message
  ).toBe(message)
}

describe("createCitySchema", () => {
  const valid = {
    nameJa: "東京",
    nameEn: "Tokyo",
    latitude: "35.6762",
    longitude: "139.6503",
    timezone: "Asia/Tokyo",
  }

  it("合法城市信息通过", () => {
    expect(createCitySchema.safeParse(valid).success).toBe(true)
  })

  it("缺日文名报 cityNameRequired", () => {
    expectMessage(
      createCitySchema.safeParse({ ...valid, nameJa: "" }),
      "nameJa",
      "cityNameRequired"
    )
  })

  it("缺英文名报 cityNameRequired", () => {
    expectMessage(
      createCitySchema.safeParse({ ...valid, nameEn: "" }),
      "nameEn",
      "cityNameRequired"
    )
  })

  it("纬度越界报 invalidLatitude", () => {
    expectMessage(
      createCitySchema.safeParse({ ...valid, latitude: "91" }),
      "latitude",
      "invalidLatitude"
    )
  })

  it("纬度为非法字符报 invalidLatitude", () => {
    expectMessage(
      createCitySchema.safeParse({ ...valid, latitude: "abc" }),
      "latitude",
      "invalidLatitude"
    )
  })

  it("纬度为空格/空串报 invalidLatitude", () => {
    expectMessage(
      createCitySchema.safeParse({ ...valid, latitude: "  " }),
      "latitude",
      "invalidLatitude"
    )
  })

  it("经度越界报 invalidLongitude", () => {
    expectMessage(
      createCitySchema.safeParse({ ...valid, longitude: "200" }),
      "longitude",
      "invalidLongitude"
    )
  })

  it("缺时区报 timezoneRequired", () => {
    expectMessage(
      createCitySchema.safeParse({ ...valid, timezone: "  " }),
      "timezone",
      "timezoneRequired"
    )
  })
})

describe("deleteCitySchema", () => {
  it("合法 uuid 通过", () => {
    expect(
      deleteCitySchema.safeParse({ cityId: crypto.randomUUID() }).success
    ).toBe(true)
  })

  it("非 uuid 报 invalidInput", () => {
    expectMessage(
      deleteCitySchema.safeParse({ cityId: "not-a-uuid" }),
      "cityId",
      "invalidInput"
    )
  })
})
