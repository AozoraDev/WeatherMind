import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }))

import { createServerClient } from "@supabase/ssr"

import { updateSession } from "./proxy"

type ProxyConfig = {
  cookies: {
    getAll: () => unknown
    setAll: (
      cookiesToSet: { name: string; value: string; options?: unknown }[],
      headers?: Record<string, string>
    ) => void
  }
}

let capturedConfig: ProxyConfig
let supabaseStub: { auth: { getUser: Mock } }

function fakeRequest() {
  const cookies = {
    getAll: vi.fn(() => [{ name: "sb", value: "v" }]),
    set: vi.fn(),
  }
  return { cookies }
}

function fakeResponse() {
  return {
    cookies: { set: vi.fn() },
    headers: { set: vi.fn() },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedConfig = {} as ProxyConfig
  supabaseStub = { auth: { getUser: vi.fn() } }
  vi.mocked(createServerClient).mockImplementation((_url, _key, config) => {
    capturedConfig = config as ProxyConfig
    return supabaseStub as never
  })
})

describe("updateSession", () => {
  it("getAll 委托请求 Cookie；返回解析出的用户与同一响应", async () => {
    const request = fakeRequest()
    const response = fakeResponse()
    supabaseStub.auth.getUser.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    })

    const result = await updateSession(
      request as never,
      response as never
    )

    expect(capturedConfig.cookies.getAll()).toEqual(request.cookies.getAll())
    expect(result.user).toEqual({ id: "u1" })
    expect(result.response).toBe(response)
  })

  it("setAll 把认证 Cookie 同时写入请求与响应", async () => {
    const request = fakeRequest()
    const response = fakeResponse()
    supabaseStub.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })

    await updateSession(request as never, response as never)

    capturedConfig.cookies.setAll([
      { name: "sb-access", value: "t", options: { httpOnly: true } },
      { name: "sb-refresh", value: "r" },
    ])

    expect(request.cookies.set).toHaveBeenNthCalledWith(1, "sb-access", "t")
    expect(request.cookies.set).toHaveBeenNthCalledWith(2, "sb-refresh", "r")
    expect(response.cookies.set).toHaveBeenNthCalledWith(
      1,
      "sb-access",
      "t",
      { httpOnly: true }
    )
    // 无 options 时第三参传 undefined（与 supabase-js 行为一致）
    expect(response.cookies.set).toHaveBeenNthCalledWith(
      2,
      "sb-refresh",
      "r",
      undefined
    )
  })

  it("setAll 透传防 CDN 缓存的 headers", async () => {
    const request = fakeRequest()
    const response = fakeResponse()
    supabaseStub.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })

    await updateSession(request as never, response as never)

    capturedConfig.cookies.setAll(
      [{ name: "sb-access", value: "t" }],
      { "cache-control": "private, no-store" }
    )

    expect(response.headers.set).toHaveBeenCalledWith(
      "cache-control",
      "private, no-store"
    )
  })
})
