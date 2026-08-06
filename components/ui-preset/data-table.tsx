import type { ComponentProps, ReactNode } from "react"

import {
  Table,
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
  children: ReactNode
}

// 通用只读表格预设：蓝色饰条 + 蓝色渐变表头 + 冷色行 hover + 统一空态，
// 供城市列表、历史天气等只读表格复用
export function DataTable({
  headers,
  empty,
  children,
  className,
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
      <Table>
        <TableHeader>
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
      </Table>
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
