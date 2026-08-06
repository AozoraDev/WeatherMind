import { describe, expect, it, vi } from "vitest"

// 只测守卫路径推导的纯函数，mock 掉中间件与 Supabase 依赖，避免拉起重运行时
vi.mock("next-intl/middleware", () => ({
  default: () => new Response(),
}))
vi.mock("next/server", () => ({
  NextResponse: { redirect: () => new Response() },
  NextRequest: class {},
}))
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(),
}))

import type { NextRequest } from "next/server"

import { guardTarget, localeOf, stripLocale } from "./proxy"

// 按 pathname 构造最小的假请求对象
function fakeReq(pathname: string) {
  return {
    nextUrl: { pathname },
    url: `https://example.com${pathname}`,
  } as unknown as NextRequest
}

describe("localeOf", () => {
  it("无前缀或非语言前缀视为默认 zh", () => {
    expect(localeOf("/")).toBe("zh")
    expect(localeOf("/login")).toBe("zh")
  })

  it("识别 /en 前缀", () => {
    expect(localeOf("/en/login")).toBe("en")
  })
})

describe("stripLocale", () => {
  it("根路径归一为 /", () => {
    expect(stripLocale("/")).toBe("/")
    expect(stripLocale("")).toBe("/")
    expect(stripLocale("/en/")).toBe("/")
  })

  it("去掉默认 zh 的前缀斜杠与末尾斜杠", () => {
    expect(stripLocale("/login")).toBe("/login")
    expect(stripLocale("/login/")).toBe("/login")
  })

  it("去掉 /en 前缀", () => {
    expect(stripLocale("/en/login")).toBe("/login")
    expect(stripLocale("/en/login/")).toBe("/login")
  })
})

describe("guardTarget", () => {
  it("默认 zh：目标不带语言前缀", () => {
    // 未登录重定向回根路径落地页
    expect(guardTarget(fakeReq("/login"), "/").toString()).toBe(
      "https://example.com/"
    )
    // 已登录重定向进仪表盘
    expect(guardTarget(fakeReq("/login"), "/dashboard").toString()).toBe(
      "https://example.com/dashboard"
    )
  })

  it("en：目标带 /en 前缀", () => {
    expect(guardTarget(fakeReq("/en/login"), "/dashboard").toString()).toBe(
      "https://example.com/en/dashboard"
    )
  })
})
