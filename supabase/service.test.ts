import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }))

import { createClient as createSupabaseClient } from "@supabase/supabase-js"

import { createServiceClient } from "./service"

const URL = "https://example.supabase.co"
const KEY = "service_role_key_123"

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

describe("createServiceClient", () => {
  it("配置齐全时用 service_role 构造免持久化客户端", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY

    createServiceClient()

    expect(createSupabaseClient).toHaveBeenCalledWith(URL, KEY, {
      auth: { persistSession: false },
    })
  })

  it("缺 service_role key → 抛配置错误，不建客户端", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL

    expect(() => createServiceClient()).toThrow(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置"
    )
    expect(createSupabaseClient).not.toHaveBeenCalled()
  })

  it("缺 URL → 抛配置错误", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY

    expect(() => createServiceClient()).toThrow(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置"
    )
  })
})
