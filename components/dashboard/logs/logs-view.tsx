"use client"

import { ScrollText } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import { DataTable, DataTableRow } from "@/components/ui-preset/data-table"
import { TableCell } from "@/components/ui/table"
import { usePaginatedNavigation } from "@/hooks/use-paginated-navigation"
import { cn } from "@/lib/utils"
import type { PageMeta } from "@/lib/weather/pagination"
import type { RunRow } from "@/lib/weather/view-types"

// 状态 → 胶囊配色：running 蓝、success 绿、partial 琥珀、failed 红，未知值灰兜底
const STATUS_STYLES: Record<string, string> = {
  running: "bg-sky-100 text-sky-700 ring-sky-600/20",
  success: "bg-emerald-100 text-emerald-700 ring-emerald-600/20",
  partial: "bg-amber-100 text-amber-700 ring-amber-600/20",
  failed: "bg-red-100 text-red-700 ring-red-600/20",
}
const STATUS_FALLBACK = "bg-slate-100 text-slate-700 ring-slate-400/20"

// 日志页视图：只读表格，逐行展示一次采集运行的触发方式、成功/失败格数与起止时间；
// 分页为服务端 URL 分页，翻页/改页长即导航到新查询串，服务端重取一页
export function LogsView({
  runs,
  pagination,
}: {
  runs: RunRow[]
  pagination: PageMeta
}) {
  const t = useTranslations("dashboard.logs")
  const locale = useLocale()
  const { goToPage } = usePaginatedNavigation()

  // 与预报页一致：按 JST 格式化时间；结束时间为空（运行中）时显示占位符
  const formatTime = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "Asia/Tokyo",
        }).format(new Date(iso))
      : "—"

  // 统一单元格间距，与城市表保持一致的视觉密度
  const CELL_CLASS = "px-4 py-3"

  return (
    <DataTable
      scrollable
      headers={[
        { label: t("columns.status"), className: CELL_CLASS },
        { label: t("columns.trigger"), className: CELL_CLASS },
        { label: t("columns.total"), className: cn(CELL_CLASS, "text-right") },
        {
          label: t("columns.succeeded"),
          className: cn(CELL_CLASS, "text-right"),
        },
        { label: t("columns.failed"), className: cn(CELL_CLASS, "text-right") },
        { label: t("columns.error"), className: CELL_CLASS },
        { label: t("columns.startedAt"), className: CELL_CLASS },
        { label: t("columns.finishedAt"), className: CELL_CLASS },
      ]}
      empty={
        runs.length === 0 ? (
          <div className="mx-auto flex max-w-xs flex-col items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-sky-50 text-sky-500 ring-1 ring-sky-200 ring-inset">
              <ScrollText className="size-5" />
            </span>
            <span className="text-sm">{t("empty")}</span>
          </div>
        ) : null
      }
      pagination={{
        page: pagination.page,
        total: pagination.total,
        totalPages: pagination.totalPages,
        // 页长固定每页 20 条，翻页即导航到新页码，服务端按新参数重取一页
        onPageChange: goToPage,
      }}
    >
      {runs.map((run) => (
        <DataTableRow key={run.id}>
          <TableCell className={CELL_CLASS}>
            {/* 状态胶囊：颜色随运行结果变化 */}
            <span
              className={cn(
                "inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
                STATUS_STYLES[run.status] ?? STATUS_FALLBACK
              )}
            >
              {t(`status.${run.status}`)}
            </span>
          </TableCell>
          <TableCell className={CELL_CLASS}>
            {t(`trigger.${run.trigger}`)}
          </TableCell>
          <TableCell
            className={cn(
              CELL_CLASS,
              "text-right font-mono text-sm tabular-nums"
            )}
          >
            {run.total_cells}
          </TableCell>
          <TableCell
            className={cn(
              CELL_CLASS,
              "text-right font-mono text-sm text-emerald-600 tabular-nums"
            )}
          >
            {run.succeeded_cells}
          </TableCell>
          <TableCell
            className={cn(
              CELL_CLASS,
              "text-right font-mono text-sm text-red-600 tabular-nums"
            )}
          >
            {run.failed_cells}
          </TableCell>
          {/* 错误摘要可能较长：限宽截断，悬停 title 查看全文 */}
          <TableCell
            className={cn(CELL_CLASS, "max-w-xs truncate text-sm")}
            title={run.error ?? undefined}
          >
            {run.error ?? "—"}
          </TableCell>
          <TableCell className={cn(CELL_CLASS, "text-sm")}>
            {formatTime(run.started_at)}
          </TableCell>
          <TableCell className={cn(CELL_CLASS, "text-sm")}>
            {formatTime(run.finished_at)}
          </TableCell>
        </DataTableRow>
      ))}
    </DataTable>
  )
}
