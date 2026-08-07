import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// 服务端 Supabase client：认证 Cookie 与请求会话双向同步，
// 供 Server Action / Route Handler 等后端代码调用（"后端调用 supabase"）
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // 读取请求中的认证 Cookie，供 auth.* 判断会话
        getAll() {
          return cookieStore.getAll()
        },
        // 登录/注册/重置成功后把认证 Cookie 写回响应；服务端组件渲染期不可写，
        // 此处吞掉异常，交由 proxy.ts 统一刷新会话
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // 服务端组件场景：Cookie 写入交给 proxy
          }
        },
      },
    }
  )
}
