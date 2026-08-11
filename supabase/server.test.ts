import { beforeEach, describe, expect, it, vi } from "vitest"

const cookieStore = vi.hoisted(() => ({
  getAll: vi.fn(),
  set: vi.fn(),
}))

vi.mock("next/headers", () => ({ cookies: vi.fn(() => cookieStore) }))
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }))

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

import { createClient } from "./server"

type CookieConfig = {
  cookies: {
    getAll: () => unknown
    setAll: (cookiesToSet: { name: string; value: string; options?: unknown }[]) => void
  }
}

let capturedConfig: CookieConfig

beforeEach(() => {
  vi.clearAllMocks()
  capturedConfig = {} as CookieConfig
  vi.mocked(createServerClient).mockImplementation(
    (_url, _key, config) => {
      capturedConfig = config as CookieConfig
      return {} as never
    }
  )
})

describe("createClient", () => {
  it("用 URL/anon key 构造服务端客户端，getAll 委托 cookieStore", async () => {
    await createClient()

    expect(createServerClient).toHaveBeenCalledWith(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      expect.any(Object)
    )

    const raw = [{ name: "sb", value: "v" }]
    vi.mocked(cookieStore.getAll).mockReturnValue(raw)
    expect(capturedConfig.cookies.getAll()).toEqual(raw)
  })

  it("setAll 把认证 Cookie 逐个写回响应 cookieStore", async () => {
    await createClient()

    capturedConfig.cookies.setAll([
      { name: "sb-access", value: "t", options: { httpOnly: true } },
      { name: "sb-refresh", value: "r" },
    ])

    expect(cookieStore.set).toHaveBeenNthCalledWith(1, "sb-access", "t", {
      httpOnly: true,
    })
    // 无 options 时第三参传 undefined（与 supabase-js 行为一致）
    expect(cookieStore.set).toHaveBeenNthCalledWith(2, "sb-refresh", "r", undefined)
  })

  it("setAll 写 cookie 抛异常时吞掉（服务端组件场景交给 proxy 刷新）", async () => {
    await createClient()
    vi.mocked(cookieStore.set).mockImplementation(() => {
      throw new Error("Cookies can only be modified in a Server Action")
    })

    expect(() =>
      capturedConfig.cookies.setAll([{ name: "sb-access", value: "t" }])
    ).not.toThrow()
  })
})
