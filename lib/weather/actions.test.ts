import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/supabase/server", () => ({ createClient: vi.fn() }))
vi.mock("./pipeline", () => ({
  runWeatherPipeline: vi.fn(),
  runWeatherBackfill: vi.fn(),
}))

import { backfillWeatherAction, refreshWeatherAction } from "./actions"
import { createClient } from "@/supabase/server"
import { runWeatherBackfill, runWeatherPipeline } from "./pipeline"
import type { RunSummary } from "./pipeline"

// 管理员白名单邮箱（见 admin.ts）
const ADMIN_EMAIL = "aozoradev@qq.com"

const summary: RunSummary = {
  runId: "run-1",
  status: "success",
  trigger: "manual",
  totalCells: 2,
  succeeded: 2,
  failed: 0,
  errors: [],
}

// 注入登录态：user 为 null 或带邮箱，getUser 返回对应结果
function mockUser(user: { email: string } | null) {
  const getUser = vi.fn().mockResolvedValue({ data: { user }, error: null })
  vi.mocked(createClient).mockResolvedValue({
    auth: { getUser },
  } as never)
  return getUser
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("refreshWeatherAction", () => {
  it("未登录返回 unauthorized，不触发管道", async () => {
    mockUser(null)
    const result = await refreshWeatherAction()

    expect(result).toEqual({ ok: false, error: "unauthorized" })
    expect(runWeatherPipeline).not.toHaveBeenCalled()
  })

  it("非管理员邮箱返回 unauthorized", async () => {
    mockUser({ email: "someone@example.com" })
    const result = await refreshWeatherAction()

    expect(result).toEqual({ ok: false, error: "unauthorized" })
    expect(runWeatherPipeline).not.toHaveBeenCalled()
  })

  it("管理员触发成功：manual 管道并返回摘要", async () => {
    mockUser({ email: ADMIN_EMAIL })
    vi.mocked(runWeatherPipeline).mockResolvedValue(summary)

    const result = await refreshWeatherAction()

    expect(result).toEqual({ ok: true, summary })
    expect(runWeatherPipeline).toHaveBeenCalledWith("manual")
  })

  it("管道抛错映射为 generic", async () => {
    mockUser({ email: ADMIN_EMAIL })
    vi.mocked(runWeatherPipeline).mockRejectedValue(new Error("boom"))

    const result = await refreshWeatherAction()

    expect(result).toEqual({ ok: false, error: "generic" })
  })
})

describe("backfillWeatherAction", () => {
  it("未登录返回 unauthorized", async () => {
    mockUser(null)
    const result = await backfillWeatherAction(7)

    expect(result).toEqual({ ok: false, error: "unauthorized" })
    expect(runWeatherBackfill).not.toHaveBeenCalled()
  })

  it("管理员默认回填 7 天", async () => {
    mockUser({ email: ADMIN_EMAIL })
    vi.mocked(runWeatherBackfill).mockResolvedValue(summary)

    const result = await backfillWeatherAction()

    expect(result).toEqual({ ok: true, summary })
    expect(runWeatherBackfill).toHaveBeenCalledWith(7)
  })

  it("天数钳制：超大值钳到 30、0 走默认 7、负值钳到 1", async () => {
    mockUser({ email: ADMIN_EMAIL })
    vi.mocked(runWeatherBackfill).mockResolvedValue(summary)

    await backfillWeatherAction(999)
    expect(runWeatherBackfill).toHaveBeenLastCalledWith(30)

    await backfillWeatherAction(0)
    expect(runWeatherBackfill).toHaveBeenLastCalledWith(7)

    await backfillWeatherAction(-5)
    expect(runWeatherBackfill).toHaveBeenLastCalledWith(1)
  })

  it("回填抛错映射为 generic", async () => {
    mockUser({ email: ADMIN_EMAIL })
    vi.mocked(runWeatherBackfill).mockRejectedValue(new Error("boom"))

    const result = await backfillWeatherAction(7)

    expect(result).toEqual({ ok: false, error: "generic" })
  })
})
