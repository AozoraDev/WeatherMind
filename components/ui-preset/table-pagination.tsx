"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { DEFAULT_PAGE_SIZE } from "@/lib/schemas/pagination"
import type { PageMeta } from "@/lib/weather/pagination"

// 通用分页条 props：分页元数据（页长固定，不再暴露）+ 页码回调；
// 城市/日志注入 URL 导航，历史页注入前端切片，组件本身不感知数据来源
export type TablePaginationProps = Omit<PageMeta, "pageSize"> & {
  onPageChange: (page: number) => void
}

// 通用分页条：左侧「共 N 条 · 每页 20 条」，右侧「上一页 / 页码 / 下一页」；
// 页长固定每页 20 条，不提供切换；首页禁上一页、末页禁下一页
export function TablePagination({
  page,
  total,
  totalPages,
  onPageChange,
}: TablePaginationProps) {
  const t = useTranslations("pagination")

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>{t("total", { count: total })}</span>
        <span>
          {t("perPage")} {DEFAULT_PAGE_SIZE}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          {t("prev")}
        </Button>
        <span className="px-2 text-sm text-muted-foreground tabular-nums">
          {t("page", { page, total: totalPages })}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          {t("next")}
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </div>
  )
}
