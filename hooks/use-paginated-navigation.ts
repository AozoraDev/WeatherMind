"use client"

import { useCallback } from "react"

import { usePathname, useRouter } from "@/i18n/navigation"

// 服务端分页导航：把 page 写进查询串后 router.push，服务端 RSC 按新页码重取一页；
// 页长固定每页 20 条，翻页不携带 pageSize。baseQuery 保留既有查询参数
// （如历史页 ?city=）。不读 useSearchParams，避免 client 组件触发
// Next 对 useSearchParams 的 Suspense 构建约束。
export function usePaginatedNavigation(baseQuery: Record<string, string> = {}) {
  const router = useRouter()
  const pathname = usePathname()

  // 跳转到指定页：只写 page 查询参数，页长固定不随导航变化
  const goToPage = useCallback(
    (page: number) => {
      router.push({ pathname, query: { ...baseQuery, page } }, { scroll: false })
    },
    [router, pathname, baseQuery]
  )

  return { goToPage }
}
