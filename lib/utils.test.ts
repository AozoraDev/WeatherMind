import { describe, expect, it } from "vitest"

import { cn, formatWeatherNumber } from "./utils"

// cn：clsx 合并 + tailwind-merge 去冲突（shadcn 通用工具）
describe("cn", () => {
  it("合并条件类名并过滤假值", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c")
  })

  it("后类覆盖冲突类（tailwind-merge）", () => {
    expect(cn("px-2", "px-4")).toBe("px-4")
  })
})

// 天气数值统一展示口径：默认一位小数；非零微量（一位小数会成 0.0）降级两位小数还原真实值
describe("formatWeatherNumber", () => {
  it("常规值保留一位小数", () => {
    expect(formatWeatherNumber(25.36)).toBe("25.4")
    expect(formatWeatherNumber(30)).toBe("30.0")
    expect(formatWeatherNumber(0.999)).toBe("1.0")
  })
  it("零值固定显示 0.0", () => {
    expect(formatWeatherNumber(0)).toBe("0.0")
    expect(formatWeatherNumber(-0)).toBe("0.0")
  })
  it("非零微量（一位小数会成 0.0）降级两位小数，避免抹成 0", () => {
    expect(formatWeatherNumber(0.02)).toBe("0.02")
    expect(formatWeatherNumber(0.04)).toBe("0.04")
    expect(formatWeatherNumber(0.0067)).toBe("0.01")
    expect(formatWeatherNumber(-0.02)).toBe("-0.02")
  })
  it("边界：一位小数能进位的不降级", () => {
    expect(formatWeatherNumber(0.05)).toBe("0.1")
  })
})
