import { createClient as createSupabaseClient } from "@supabase/supabase-js"

// 服务端专用 service_role 客户端：绕过 RLS，仅用于管道写入与城市增删两个受信路径。
// 切勿在客户端组件中 import 本文件（会泄漏 service_role key，必须保持服务端专用）。
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置")
  }
  return createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}
