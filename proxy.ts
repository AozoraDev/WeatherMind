import createMiddleware from "next-intl/middleware"
import { NextResponse, type NextRequest } from "next/server"

import { routing } from "./i18n/routing"
import { updateSession } from "./lib/supabase/proxy"

const intlMiddleware = createMiddleware(routing)

// 未登录时可访问的白名单路径（不含 locale 前缀）：根路径落地页/登录/注册/忘记密码
const PUBLIC_PATHS = new Set(["/", "/login", "/register", "/forgot-password"])

// 取请求对应的 locale：zh 为默认不带前缀，en 带 /en 前缀
// （导出供单测直接验证守卫路径推导）
export function localeOf(pathname: string): string {
  const first = pathname.split("/")[1] ?? ""
  return routing.locales.find((l) => l === first) ?? routing.defaultLocale
}

// 去掉可选的 locale 前缀与末尾斜杠，得到站内逻辑路径（用于白名单匹配）
// （导出供单测直接验证路径归一化）
export function stripLocale(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "") || "/"
  const first = normalized.split("/")[1] ?? ""
  if (routing.locales.find((l) => l === first)) {
    return normalized.slice(first.length + 1) || "/"
  }
  return normalized
}

// 按请求 locale 前缀拼出守卫重定向目标
// （导出供单测验证不同 locale 下的重定向目标）
export function guardTarget(request: NextRequest, path: string): URL {
  const locale = localeOf(request.nextUrl.pathname)
  const target = locale === routing.defaultLocale ? path : `/${locale}${path}`
  return new URL(target, request.url)
}

// 守卫重定向：303 让 POST（Server Action）降级为 GET，并把会话刷新 Cookie 一并带过去
function guardRedirect(intlResponse: NextResponse, target: URL): NextResponse {
  const response = NextResponse.redirect(target, 303)
  intlResponse.headers
    .getSetCookie()
    .forEach((cookie) => response.headers.append("Set-Cookie", cookie))
  return response
}

// 请求入口：next-intl 先协商 locale 产出响应，再刷新 Supabase 会话并按登录态守卫路由。
// 顺序不可颠倒——supabase 需复用 intl 的 response，重建会丢 rewrite
export default async function proxy(request: NextRequest) {
  const intlResponse = intlMiddleware(request)
  const { response, user } = await updateSession(request, intlResponse)

  const path = stripLocale(request.nextUrl.pathname)

  // 未登录：仅放行白名单页面，其余一律重定向到根路径落地页
  if (!user && !PUBLIC_PATHS.has(path)) {
    return guardRedirect(response, guardTarget(request, "/"))
  }
  // 已登录：不再停留于落地页/登录/注册/忘记密码，直接进仪表盘
  if (user && PUBLIC_PATHS.has(path)) {
    return guardRedirect(response, guardTarget(request, "/dashboard"))
  }

  return response
}

export const config = {
  // 跳过内部路径与带扩展名的静态资源
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
}
