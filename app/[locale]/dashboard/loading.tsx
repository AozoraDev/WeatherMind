import { Loader2 } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { Skeleton } from "@/components/ui/skeleton"

// 仪表盘路由级加载态：切换二级路由（预报/历史/城市等）时作为 Suspense fallback 渲染，
// 用与真实页面同构的骨架屏占位，导航即时反馈，替代白屏等待
export default async function Loading() {
  const t = await getTranslations("dashboard")

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-full flex-col gap-6 p-6"
    >
      {/* 页面头部骨架：标题 + 描述占位 */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* 工具栏骨架：搜索框 + 操作按钮占位 */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-24" />
      </div>

      {/* 内容区骨架：卡片网格占位，与预报页卡片布局对齐 */}
      <div className="grid flex-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-4 h-8 w-16" />
            <Skeleton className="mt-3 h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-4/5" />
          </div>
        ))}
      </div>

      {/* 加载指示：旋转图标 + 文案 */}
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        {t("loading")}
      </div>
    </div>
  )
}
