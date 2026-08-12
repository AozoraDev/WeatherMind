import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/supabase/server", () => ({ createClient: vi.fn() }))
vi.mock("@/supabase/service", () => ({ createServiceClient: vi.fn() }))

import { createClient } from "@/supabase/server"
import { createServiceClient } from "@/supabase/service"

import {
  createConversationAction,
  deleteConversationAction,
} from "./conversation-actions"

const USER_ID = "11111111-2222-3333-4444-555555555555"
const CONVERSATION_ID = "a5e6a111-6b61-4e0f-91c2-5f2f3e4a5b6c"

// 注入登录态：user 为 null 或带 id/email，getUser 返回对应结果
function mockUser(user: { id?: string; email: string } | null) {
  const getUser = vi.fn().mockResolvedValue({ data: { user }, error: null })
  vi.mocked(createClient).mockResolvedValue({ auth: { getUser } } as never)
}

// service 客户端链式桩：建（insert().select().single()）与删（delete().eq().eq().select()）两条路径
function mockServiceClient() {
  const single = vi.fn()
  const selectAfterInsert = vi.fn(() => ({ single }))
  const selectAfterDelete = vi.fn()
  const eqAfterDelete = vi.fn(() => ({ eq: eqAfterDelete, select: selectAfterDelete }))
  const insert = vi.fn(() => ({ select: selectAfterInsert }))
  const del = vi.fn(() => ({ eq: eqAfterDelete }))
  const from = vi.fn(() => ({ insert, delete: del }))
  vi.mocked(createServiceClient).mockReturnValue({ from } as never)
  return { from, insert, single, selectAfterInsert, selectAfterDelete, eqAfterDelete, del }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("createConversationAction", () => {
  it("未登录 → unauthorized，不触写库", async () => {
    mockUser(null)
    const result = await createConversationAction()

    expect(result).toEqual({ ok: false, error: "unauthorized" })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it("登录成功新建：insert 携带 user_id，返回新会话 id", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { insert, single } = mockServiceClient()
    single.mockResolvedValue({ data: { id: CONVERSATION_ID }, error: null })

    const result = await createConversationAction()

    expect(result).toEqual({ ok: true, id: CONVERSATION_ID })
    expect(insert).toHaveBeenCalledWith({ user_id: USER_ID })
  })

  it("写入报错 → generic", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { single } = mockServiceClient()
    single.mockResolvedValue({ data: null, error: { message: "no table" } })

    const result = await createConversationAction()

    expect(result).toEqual({ ok: false, error: "generic" })
  })

  it("返回无 id（理论不达）→ generic", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { single } = mockServiceClient()
    single.mockResolvedValue({ data: null, error: null })

    const result = await createConversationAction()

    expect(result).toEqual({ ok: false, error: "generic" })
  })

  it("写入抛异常 → generic", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { single } = mockServiceClient()
    single.mockRejectedValue(new Error("boom"))

    const result = await createConversationAction()

    expect(result).toEqual({ ok: false, error: "generic" })
  })
})

describe("deleteConversationAction", () => {
  it("非法 uuid → invalidInput，不触鉴权与写库", async () => {
    const result = await deleteConversationAction({ id: "not-a-uuid" })

    expect(result).toEqual({ ok: false, error: "invalidInput" })
    expect(createClient).not.toHaveBeenCalled()
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it("未登录 → unauthorized", async () => {
    mockUser(null)
    const result = await deleteConversationAction({ id: CONVERSATION_ID })

    expect(result).toEqual({ ok: false, error: "unauthorized" })
  })

  it("登录成功删除：delete().eq(id).eq(user_id).select(id) 返回被删行", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { selectAfterDelete } = mockServiceClient()
    selectAfterDelete.mockResolvedValue({ data: [{ id: CONVERSATION_ID }], error: null })

    const result = await deleteConversationAction({ id: CONVERSATION_ID })

    expect(result).toEqual({ ok: true })
  })

  it("删除 0 行（非本人/已删）→ notFound", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { selectAfterDelete } = mockServiceClient()
    selectAfterDelete.mockResolvedValue({ data: [], error: null })

    const result = await deleteConversationAction({ id: CONVERSATION_ID })

    expect(result).toEqual({ ok: false, error: "notFound" })
  })

  it("数据库错误 → generic", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { selectAfterDelete } = mockServiceClient()
    selectAfterDelete.mockResolvedValue({ data: null, error: { message: "fk" } })

    const result = await deleteConversationAction({ id: CONVERSATION_ID })

    expect(result).toEqual({ ok: false, error: "generic" })
  })

  it("删除抛异常 → generic", async () => {
    mockUser({ id: USER_ID, email: "a@b.com" })
    const { selectAfterDelete } = mockServiceClient()
    selectAfterDelete.mockRejectedValue(new Error("boom"))

    const result = await deleteConversationAction({ id: CONVERSATION_ID })

    expect(result).toEqual({ ok: false, error: "generic" })
  })
})
