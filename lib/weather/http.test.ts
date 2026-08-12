import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fetchJson, fetchStream } from "./http"

// 统一网络封装：fetchJson（取 JSON）与 fetchStream（不读 body 的流式）。
// 桩全局 fetch 覆盖三类分支：2xx、非 2xx、网络异常（抛错/无 body）

const mockFetch = vi.fn()

function fakeResponse(overrides: {
  ok?: boolean
  body?: unknown
  json?: unknown
}) {
  return {
    ok: overrides.ok ?? true,
    body: overrides.body,
    json: async () => overrides.json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch)
})

afterEach(() => {
  mockFetch.mockReset()
  vi.unstubAllGlobals()
})

describe("fetchJson", () => {
  it("2xx → ok:true + json", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ ok: true, json: { a: 1 } }))
    await expect(fetchJson("https://x.test/api")).resolves.toEqual({
      ok: true,
      json: { a: 1 },
    })
  })

  it("非 2xx → http", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ ok: false }))
    await expect(fetchJson("https://x.test/api")).resolves.toEqual({
      ok: false,
      error: "http",
    })
  })

  it("网络异常/解析失败 → network", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(fetchJson("https://x.test/api")).resolves.toEqual({
      ok: false,
      error: "network",
    })
  })

  it("请求参数：no-store 缓存 + accept json + 自定义头合并", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ ok: true, json: {} }))
    await fetchJson("https://x.test/api", {
      headers: { authorization: "Bearer t" },
    })
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x.test/api",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          accept: "application/json",
          authorization: "Bearer t",
        }),
      })
    )
  })

  it("传入 timeoutMs → 用 AbortSignal.timeout 限时", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ ok: true, json: {} }))
    await fetchJson("https://x.test/api", {}, 5000)
    const init = mockFetch.mock.calls[0][1] as { signal: AbortSignal }
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("fetchStream", () => {
  it("2xx + body → ok:true 返回 response，不读 body", async () => {
    const body = new ReadableStream()
    mockFetch.mockResolvedValue(fakeResponse({ ok: true, body }))
    const res = await fetchStream("https://x.test/api")
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.response.body).toBe(body)
  })

  it("非 2xx → http", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ ok: false }))
    await expect(fetchStream("https://x.test/api")).resolves.toEqual({
      ok: false,
      error: "http",
    })
  })

  it("2xx 但无 body → network（读不到数据）", async () => {
    mockFetch.mockResolvedValue(fakeResponse({ ok: true, body: null }))
    await expect(fetchStream("https://x.test/api")).resolves.toEqual({
      ok: false,
      error: "network",
    })
  })

  it("网络异常 → network", async () => {
    mockFetch.mockRejectedValue(new Error("boom"))
    await expect(fetchStream("https://x.test/api")).resolves.toEqual({
      ok: false,
      error: "network",
    })
  })

  it("固定 redirect:manual（SSRF：不跟随 3xx，防跳转绕过初始 URL 前置校验）", async () => {
    mockFetch.mockResolvedValue(
      fakeResponse({ ok: true, body: new ReadableStream() })
    )
    await fetchStream("https://x.test/api")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x.test/api",
      expect.objectContaining({ redirect: "manual" })
    )
  })

  it("覆盖调用方传的 follow：redirect 强制 manual，防外部误传", async () => {
    mockFetch.mockResolvedValue(
      fakeResponse({ ok: true, body: new ReadableStream() })
    )
    await fetchStream("https://x.test/api", { redirect: "follow" })
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x.test/api",
      expect.objectContaining({ redirect: "manual" })
    )
  })

  it("请求参数：no-store + accept text/event-stream（流式消费者）", async () => {
    mockFetch.mockResolvedValue(
      fakeResponse({ ok: true, body: new ReadableStream() })
    )
    await fetchStream("https://x.test/api")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://x.test/api",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({ accept: "text/event-stream" }),
      })
    )
  })

  it("传入 timeoutMs → 带 AbortSignal 信号", async () => {
    mockFetch.mockResolvedValue(
      fakeResponse({ ok: true, body: new ReadableStream() })
    )
    await fetchStream("https://x.test/api", {}, 3000)
    const init = mockFetch.mock.calls[0][1] as { signal: AbortSignal }
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("外部 signal + timeout 合并：中止外部信号 → 请求被取消归 network", async () => {
    // 客户端断线信号与超时信号用 AbortSignal.any 合并，任一触发即取消；
    // 此处验证外部信号确实接进了 fetch（断线省 token 的关键路径）
    const controller = new AbortController()
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          )
        })
    )
    const pending = fetchStream(
      "https://x.test/api",
      { signal: controller.signal },
      5000
    )
    controller.abort()
    await expect(pending).resolves.toEqual({ ok: false, error: "network" })
  })
})
