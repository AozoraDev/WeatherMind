import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/supabase/server", () => ({ createClient: vi.fn() }))

import { createClient } from "@/supabase/server"

import {
  createSseResponse,
  readJsonBody,
  requireUser,
} from "./route-helpers"

const USER = { id: "11111111-2222-3333-4444-555555555555", email: "a@b.com" }

// 注入登录态：user 为 null 或带 id/email，getUser 返回对应结果
function mockUser(user: { id: string; email: string } | null) {
  const getUser = vi.fn().mockResolvedValue({ data: { user }, error: null })
  vi.mocked(createClient).mockResolvedValue({ auth: { getUser } } as never)
}

// 读空 SSE 响应体，逐帧解码拼接
async function readStreamBody(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const chunks: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(new TextDecoder().decode(value))
  }
  return chunks.join("")
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("requireUser", () => {
  it("未登录 → 401 unauthorized", async () => {
    mockUser(null)
    const result = await requireUser()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(401)
      await expect(result.response.json()).resolves.toEqual({
        error: "unauthorized",
      })
    }
  })

  it("已登录 → 返回 user 与 session", async () => {
    mockUser(USER)
    const result = await requireUser()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.user.email).toBe("a@b.com")
      expect(result.session).toBeDefined()
    }
  })
})

describe("readJsonBody", () => {
  it("合法 JSON → ok 返回 body", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ cityId: "1" }),
    })
    const result = await readJsonBody(req)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.body).toEqual({ cityId: "1" })
  })

  it("非法 JSON → 400 no-model", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: "{oops",
    })
    const result = await readJsonBody(req)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(400)
      await expect(result.response.json()).resolves.toEqual({
        error: "no-model",
      })
    }
  })
})

describe("createSseResponse", () => {
  it("run 正常发事件：逐条 data: 帧 + SSE 响应头", async () => {
    const res = createSseResponse(async (send) => {
      send({ type: "chunk", text: "晴" })
      send({ type: "done" })
    })

    expect(res.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8"
    )
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform")
    expect(res.headers.get("X-Accel-Buffering")).toBe("no")
    await expect(readStreamBody(res)).resolves.toBe(
      'data: {"type":"chunk","text":"晴"}\n\ndata: {"type":"done"}\n\n'
    )
  })

  it("run 抛错 → 带内 generic error 事件兜底", async () => {
    const res = createSseResponse(async () => {
      throw new Error("boom")
    })

    await expect(readStreamBody(res)).resolves.toBe(
      'data: {"type":"error","code":"generic"}\n\n'
    )
  })

  it("客户端断开（send 抛错）→ 静默结束，无未捕获异常", async () => {
    let proceed!: () => void
    const gate = new Promise<void>((r) => {
      proceed = r
    })
    const res = createSseResponse(async (send) => {
      // 等测试取消流后再发事件：已取消的流上 enqueue 会抛 TypeError，
      // 应被 createSseResponse 内的双重 try/catch 兜住静默结束
      await gate
      send({ type: "chunk" })
    })
    const reader = res.body!.getReader()
    await reader.cancel()
    proceed()
    // 让 start 的微任务跑完：若异常逃逸，vitest 会以未处理 rejection 失败
    await new Promise((r) => setTimeout(r, 10))
    await expect(reader.closed).resolves.toBeUndefined()
  })
})
