"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"

// TanStack Query Provider：应用根部注入，鉴权表单等 useMutation 依赖此上下文；
// 统一关闭 mutation 重试，避免网络抖动时重复提交
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: 0 },
        },
      })
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
