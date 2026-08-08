import type { ComponentProps, ReactNode } from "react"

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

type DataTableProps = ComponentProps<"div"> & {
  // 列标题与每列样式（如数字列右对齐），由调用方注入以保持不感知 i18n
  headers: { label: ReactNode; className?: string }[]
  // 空态内容：无数据时调用方传入（含图标/文案），否则传 null
  empty?: ReactNode
  // 开启表内滚动：限高后容器同时承接横/纵向滚动，表头吸顶，行多列宽时信息不丢失
  scrollable?: boolean
  children: ReactNode
}

// 通用只读表格预设：蓝色饰条 + 蓝色渐变表头 + 冷色行 hover + 统一空态，
// 供城市列表、历史天气等只读表格复用
export function DataTable({
  headers,
  empty,
  children,
  className,
  scrollable = false,
}: DataTableProps) {
  const headClass =
    "text-xs font-medium uppercase tracking-wide text-muted-foreground"

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-sm",
        className
      )}
    >
      {/* 顶部蓝色饰条：给整表一个蓝色签名 */}
      <div
        aria-hidden="true"
        className="h-1 bg-linear-to-r from-sky-400 to-blue-500"
      />
      {/* 滚动容器直接包住 <table>（不复用 shadcn Table 自带的内层滚动 div，否则表头吸顶
          会锚定到内层容器而非本容器）；scrollable 时承接横/纵向滚动，否则行为与之前一致 */}
      <div
        className={cn(
          "relative w-full",
          scrollable ? "max-h-[70vh] overflow-auto" : "overflow-x-auto"
        )}
      >
        <table className="w-full caption-bottom text-sm">
          <TableHeader
            className={cn(scrollable && "sticky top-0 z-10 bg-card")}
          >
            <TableRow className="bg-linear-to-r from-sky-100 via-blue-50 to-indigo-100 hover:from-sky-100 hover:via-blue-50 hover:to-indigo-100">
              {headers.map((col, i) => (
                <TableHead key={i} className={cn(headClass, col.className)}>
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {empty !== null && empty !== undefined ? (
              <TableRow>
                <TableCell
                  colSpan={headers.length}
                  className="py-12 text-center text-muted-foreground"
                >
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              children
            )}
          </TableBody>
        </table>
      </div>
    </div>
  )
}

// 数据行预设：蓝色 hover 与整表风格一致
export function DataTableRow({
  className,
  ...props
}: ComponentProps<typeof TableRow>) {
  return <TableRow className={cn("hover:bg-sky-50/50", className)} {...props} />
}
