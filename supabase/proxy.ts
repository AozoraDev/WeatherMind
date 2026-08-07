import { createServerClient } from "@supabase/ssr"
import type { NextRequest, NextResponse } from "next/server"

// proxy 会话刷新：在 next-intl 已产出的响应上同步 Supabase 认证 Cookie，
// 并对过期 token 自动续期。必须复用传入的 response，重建会丢掉 rewrite。
// 返回值附带解析出的用户，供根 proxy.ts 做路由守卫
export async function updateSession(
  request: NextRequest,
  supabaseResponse: NextResponse
) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        // 认证 Cookie 同时写入请求（供本代理后续判断）与响应（下发给浏览器）；
        // 第二参为防 CDN 缓存的 cache 头，一并透传
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
          Object.entries(headers ?? {}).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value)
          )
        },
      },
    }
  )

  // 触发会话加载与刷新（过期 token 自动续期并写回 Cookie）
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return { response: supabaseResponse, user }
}
