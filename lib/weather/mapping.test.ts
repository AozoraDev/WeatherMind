import { describe, expect, it } from "vitest"

import { kphToMps, mapOwmCode, mapWeatherApiCode, mapWmoCode } from "./mapping"

describe("mapWmoCode（Open-Meteo / WMO）", () => {
  it("晴", () => expect(mapWmoCode(0)).toBe("clear"))
  it("多云", () => {
    expect(mapWmoCode(1)).toBe("partlyCloudy")
    expect(mapWmoCode(3)).toBe("partlyCloudy")
  })
  it("雾", () => {
    expect(mapWmoCode(45)).toBe("fog")
    expect(mapWmoCode(48)).toBe("fog")
  })
  it("雨（毛毛雨/雨/阵雨）", () => {
    expect(mapWmoCode(51)).toBe("rain")
    expect(mapWmoCode(61)).toBe("rain")
    expect(mapWmoCode(80)).toBe("rain")
  })
  it("雪", () => {
    expect(mapWmoCode(71)).toBe("snow")
    expect(mapWmoCode(85)).toBe("snow")
  })
  it("雷暴", () => {
    expect(mapWmoCode(95)).toBe("storm")
    expect(mapWmoCode(99)).toBe("storm")
  })
  it("未知码归 other", () => expect(mapWmoCode(999)).toBe("other"))
})

describe("mapOwmCode（OpenWeatherMap）", () => {
  it("晴", () => expect(mapOwmCode(800)).toBe("clear"))
  it("雷暴（2xx）", () => expect(mapOwmCode(212)).toBe("storm"))
  it("雨（3xx/5xx）", () => {
    expect(mapOwmCode(310)).toBe("rain")
    expect(mapOwmCode(502)).toBe("rain")
  })
  it("雪（6xx）", () => expect(mapOwmCode(602)).toBe("snow"))
  it("雾/霾（7xx）", () => expect(mapOwmCode(741)).toBe("fog"))
  it("多云间晴（801/802）", () => {
    expect(mapOwmCode(801)).toBe("partlyCloudy")
    expect(mapOwmCode(802)).toBe("partlyCloudy")
  })
  it("阴（803/804）", () => {
    expect(mapOwmCode(803)).toBe("cloudy")
    expect(mapOwmCode(804)).toBe("cloudy")
  })
  it("未知码归 other", () => expect(mapOwmCode(999)).toBe("other"))
})

describe("mapWeatherApiCode（WeatherAPI.com）", () => {
  it("晴", () => expect(mapWeatherApiCode(1000)).toBe("clear"))
  it("多云间晴", () => expect(mapWeatherApiCode(1003)).toBe("partlyCloudy"))
  it("阴", () => {
    expect(mapWeatherApiCode(1006)).toBe("cloudy")
    expect(mapWeatherApiCode(1009)).toBe("cloudy")
  })
  it("雾", () => {
    expect(mapWeatherApiCode(1030)).toBe("fog")
    expect(mapWeatherApiCode(1135)).toBe("fog")
  })
  it("雷暴", () => {
    expect(mapWeatherApiCode(1087)).toBe("storm")
    expect(mapWeatherApiCode(1276)).toBe("storm")
  })
  it("雨", () => {
    expect(mapWeatherApiCode(1180)).toBe("rain")
    expect(mapWeatherApiCode(1243)).toBe("rain")
  })
  it("雪", () => {
    expect(mapWeatherApiCode(1210)).toBe("snow")
    expect(mapWeatherApiCode(1282)).toBe("snow")
  })
  it("未知码归 other", () => expect(mapWeatherApiCode(999)).toBe("other"))
})

describe("kphToMps", () => {
  it("36 km/h → 10 m/s", () => expect(kphToMps(36)).toBe(10))
  it("3.6 km/h → 1 m/s", () => expect(kphToMps(3.6)).toBe(1))
  it("保留两位小数", () => expect(kphToMps(5)).toBe(1.39))
})
