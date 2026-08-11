import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/supabase/server", () => ({ createClient: vi.fn() }))
vi.mock("@/supabase/service", () => ({ createServiceClient: vi.fn() }))

import { createClient } from "@/supabase/server"
import { createServiceClient } from "@/supabase/service"

import { createCityAction, deleteCityAction } from "./city-actions"

// 管理员白名单邮箱（见 admin.ts），getUser 注入该邮箱即通过门禁
const ADMIN_EMAIL = "aozoradev@qq.com"

// 注入登录态：user 为 null 或带邮箱，getUser 返回对应结果
function mockUser(user: { email: string } | null) {
  const getUser = vi.fn().mockResolvedValue({ data: { user }, error: null })
  vi.mocked(createClient).mockResolvedValue({ auth: { getUser } } as never)
}

// service 客户端链式桩：insert / delete().eq().select() 两条路径都可测
function mockServiceClient() {
  const insert = vi.fn()
  const select = vi.fn()
  const eq = vi.fn(() => ({ select }))
  const del = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ insert, delete: del }))
  vi.mocked(createServiceClient).mockReturnValue({ from } as never)
  return { from, insert, del, eq, select }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("createCityAction", () => {
  const valid = {
    nameJa: " 東京 ",
    nameEn: " Tokyo ",
    latitude: "35.6762",
    longitude: "139.6503",
    timezone: " Asia/Tokyo ",
  }

  it("schema 校验失败 → invalidInput，不触鉴权与服务端", async () => {
    const result = await createCityAction({ ...valid, latitude: "abc" })

    expect(result).toEqual({ ok: false, error: "invalidInput" })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it("未登录 → unauthorized", async () => {
    mockUser(null)
    const result = await createCityAction(valid)

    expect(result).toEqual({ ok: false, error: "unauthorized" })
  })

  it("非管理员邮箱 → unauthorized", async () => {
    mockUser({ email: "someone@example.com" })
    const result = await createCityAction(valid)

    expect(result).toEqual({ ok: false, error: "unauthorized" })
  })

  it("管理员成功新增：trim 后入库，经纬度转数字", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { insert } = mockServiceClient()
    insert.mockResolvedValue({ error: null })

    const result = await createCityAction(valid)

    expect(result).toEqual({ ok: true })
    expect(insert).toHaveBeenCalledWith({
      name_ja: "東京",
      name_en: "Tokyo",
      latitude: 35.6762,
      longitude: 139.6503,
      timezone: "Asia/Tokyo",
    })
  })

  it("唯一冲突 23505 → duplicate", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { insert } = mockServiceClient()
    insert.mockResolvedValue({ error: { code: "23505", message: "dup" } })

    const result = await createCityAction(valid)

    expect(result).toEqual({ ok: false, error: "duplicate" })
  })

  it("其他数据库错误 → generic", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { insert } = mockServiceClient()
    insert.mockResolvedValue({ error: { code: "42P01", message: "no table" } })

    const result = await createCityAction(valid)

    expect(result).toEqual({ ok: false, error: "generic" })
  })

  it("写入抛异常 → generic", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { insert } = mockServiceClient()
    insert.mockRejectedValue(new Error("boom"))

    const result = await createCityAction(valid)

    expect(result).toEqual({ ok: false, error: "generic" })
  })
})

describe("deleteCityAction", () => {
  const cityId = "a5e6a111-6b61-4e0f-91c2-5f2f3e4a5b6c"

  it("非法 uuid → invalidInput", async () => {
    const result = await deleteCityAction({ cityId: "not-a-uuid" })

    expect(result).toEqual({ ok: false, error: "invalidInput" })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it("未登录 → unauthorized", async () => {
    mockUser(null)
    const result = await deleteCityAction({ cityId })

    expect(result).toEqual({ ok: false, error: "unauthorized" })
  })

  it("管理员成功删除：delete().eq(id).select(id) 返回被删行", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { del, eq, select } = mockServiceClient()
    select.mockResolvedValue({ data: [{ id: cityId }], error: null })

    const result = await deleteCityAction({ cityId })

    expect(result).toEqual({ ok: true })
    expect(del).toHaveBeenCalled()
    expect(eq).toHaveBeenCalledWith("id", cityId)
    expect(select).toHaveBeenCalledWith("id")
  })

  it("数据库错误 → generic", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { select } = mockServiceClient()
    select.mockResolvedValue({ data: null, error: { message: "fk" } })

    const result = await deleteCityAction({ cityId })

    expect(result).toEqual({ ok: false, error: "generic" })
  })

  it("删除 0 行（数据已被并发删掉）→ notFound", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { select } = mockServiceClient()
    select.mockResolvedValue({ data: [], error: null })

    const result = await deleteCityAction({ cityId })

    expect(result).toEqual({ ok: false, error: "notFound" })
  })

  it("删除抛异常 → generic", async () => {
    mockUser({ email: ADMIN_EMAIL })
    const { select } = mockServiceClient()
    select.mockRejectedValue(new Error("boom"))

    const result = await deleteCityAction({ cityId })

    expect(result).toEqual({ ok: false, error: "generic" })
  })
})
