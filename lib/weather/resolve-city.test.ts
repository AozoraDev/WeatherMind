import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/i18n/navigation", () => ({ redirect: vi.fn() }))
vi.mock("next-intl/server", () => ({ getLocale: vi.fn() }))

import { resolveCityParam } from "./resolve-city"
import { redirect } from "@/i18n/navigation"
import { getLocale } from "next-intl/server"
import type { CityRow } from "./view-types"

// 构造最小城市行，name_en 参与匹配，其余字段仅占位
function city(name_en: string, overrides: Partial<CityRow> = {}): CityRow {
  return {
    id: name_en.toLowerCase(),
    name_ja: name_en,
    name_en,
    latitude: 35.68,
    longitude: 139.69,
    timezone: "Asia/Tokyo",
    is_active: true,
    ...overrides,
  }
}

const PATHNAME = "/dashboard/forecast"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getLocale).mockResolvedValue("zh")
})

describe("resolveCityParam", () => {
  it("空城市列表直接返回 null，不重定向", async () => {
    await expect(resolveCityParam([], "tokyo", PATHNAME)).resolves.toBeNull()
    expect(redirect).not.toHaveBeenCalled()
  })

  it("?city= 命中时返回该城市且不重定向（大小写不敏感）", async () => {
    const cities = [city("Osaka"), city("Tokyo")]
    const selected = await resolveCityParam(cities, "OSAKA", PATHNAME)

    expect(selected).toEqual(cities[0])
    expect(redirect).not.toHaveBeenCalled()
  })

  it("?city= 无效时回退东京并重定向到规范 URL", async () => {
    const cities = [city("Osaka"), city("Tokyo")]
    const selected = await resolveCityParam(cities, "nope", PATHNAME)

    expect(selected).toEqual(cities[1])
    expect(redirect).toHaveBeenCalledWith({
      href: { pathname: PATHNAME, query: { city: "Tokyo" } },
      locale: "zh",
    })
  })

  it("?city= 缺失且无东京时取第一个城市并重定向", async () => {
    const cities = [city("Osaka"), city("Kyoto")]
    const selected = await resolveCityParam(cities, undefined, PATHNAME)

    expect(selected).toEqual(cities[0])
    expect(redirect).toHaveBeenCalledWith({
      href: { pathname: PATHNAME, query: { city: "Osaka" } },
      locale: "zh",
    })
  })

  it("?city= 为空串按缺失处理，回退并重定向", async () => {
    const cities = [city("Tokyo"), city("Osaka")]
    const selected = await resolveCityParam(cities, "", PATHNAME)

    expect(selected).toEqual(cities[0])
    expect(redirect).toHaveBeenCalledWith({
      href: { pathname: PATHNAME, query: { city: "Tokyo" } },
      locale: "zh",
    })
  })
})
