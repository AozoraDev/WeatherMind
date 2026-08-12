"use client"

import { useMutation } from "@tanstack/react-query"
import { CloudSun, History, MapPin, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"

import { CityAddDialog } from "@/components/dashboard/cities/city-add-dialog"
import { ButtonBlue } from "@/components/ui-preset/button"
import { DataTable, DataTableRow } from "@/components/ui-preset/data-table"
import { useToast } from "@/components/ui-preset/toast"
import { buttonVariants, Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TableCell } from "@/components/ui/table"
import { Link, useRouter } from "@/i18n/navigation"
import { usePaginatedNavigation } from "@/hooks/use-paginated-navigation"
import { cn } from "@/lib/utils"
import { deleteCityAction } from "@/lib/weather/city-actions"
import { CityError } from "@/lib/weather/errors"
import type { PageMeta } from "@/lib/weather/pagination"
import type { CityRow } from "@/lib/weather/view-types"

// 城市页视图：只读表格 + 管理员专属「新增城市」与行内删除（含确认弹窗）；
// 分页为服务端 URL 分页，翻页/改页长即导航到新查询串，服务端重取一页
export function CitiesView({
  cities,
  pagination,
  isAdmin,
}: {
  cities: CityRow[]
  pagination: PageMeta
  isAdmin: boolean
}) {
  const t = useTranslations("dashboard.cities")
  const router = useRouter()
  const toast = useToast()
  const { goToPage } = usePaginatedNavigation()

  const [deleteTarget, setDeleteTarget] = useState<CityRow | null>(null)

  // 删除动作：确认后硬删，FK 级联清掉该城天气数据；成功后刷新列表
  const deleteMutation = useMutation({
    mutationFn: async (cityId: string) => {
      const res = await deleteCityAction({ cityId })
      if (!res.ok) throw new CityError(res.error)
    },
    onSuccess: () => {
      toast.success(t("success.deleted"))
      setDeleteTarget(null)
      router.refresh()
    },
    onError: (e) => {
      toast.error(
        e instanceof CityError ? t(`errors.${e.code}`) : t("errors.generic")
      )
    },
  })

  // 城市表统一单元格间距：比默认 p-2 宽松，为行内「显示历史」按钮留出呼吸感
  const CELL_CLASS = "px-4 py-3"

  return (
    <div className="flex flex-col gap-6">
      {/* 顶部操作行：管理员才显示「新增城市」入口 */}
      <div className="flex items-center justify-end">
        {isAdmin && <CityAddDialog />}
      </div>

      <DataTable
        headers={[
          { label: t("columns.name"), className: CELL_CLASS },
          { label: t("columns.lat"), className: cn(CELL_CLASS, "text-right") },
          { label: t("columns.lon"), className: cn(CELL_CLASS, "text-right") },
          { label: t("columns.timezone"), className: CELL_CLASS },
          { label: t("columns.showForecast"), className: CELL_CLASS },
          { label: t("columns.showHistory"), className: CELL_CLASS },
          ...(isAdmin
            ? [{ label: t("columns.actions"), className: CELL_CLASS }]
            : []),
        ]}
        empty={
          cities.length === 0 ? (
            <div className="mx-auto flex max-w-xs flex-col items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-sky-50 text-sky-500 ring-1 ring-sky-200 ring-inset">
                <MapPin className="size-5" />
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
        {cities.map((city) => (
          <DataTableRow key={city.id}>
            <TableCell className={cn(CELL_CLASS, "font-medium")}>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full bg-sky-500"
                />
                {city.name_ja} · {city.name_en}
              </span>
            </TableCell>
            <TableCell
              className={cn(
                CELL_CLASS,
                "text-right font-mono text-sm text-muted-foreground tabular-nums"
              )}
            >
              {city.latitude.toFixed(4)}
            </TableCell>
            <TableCell
              className={cn(
                CELL_CLASS,
                "text-right font-mono text-sm text-muted-foreground tabular-nums"
              )}
            >
              {city.longitude.toFixed(4)}
            </TableCell>
            <TableCell className={CELL_CLASS}>
              {/* 时区用蓝色胶囊弱化展示，避免整表被长文本占满 */}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-700 ring-1 ring-sky-600/20 ring-inset">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-sky-500"
                />
                {city.timezone}
              </span>
            </TableCell>
            <TableCell className={CELL_CLASS}>
              {/* 蓝色按钮跳转到对应城市的预报页，用 query 参数指定城市 */}
              <Link
                href={{
                  pathname: "/dashboard/forecast",
                  query: { city: city.name_en },
                }}
                className={cn(
                  buttonVariants({ size: "sm" }),
                  "bg-[#2563eb] text-white hover:bg-[#3B82F6]"
                )}
              >
                <CloudSun aria-hidden="true" className="size-3.5" />
                {t("columns.showForecast")}
              </Link>
            </TableCell>
            <TableCell className={CELL_CLASS}>
              {/* 绿色按钮跳转到对应城市的历史页，用 query 参数指定城市 */}
              <Link
                href={{
                  pathname: "/dashboard/history",
                  query: { city: city.name_en },
                }}
                className={cn(
                  buttonVariants({ size: "sm" }),
                  "bg-[#10b981] text-white hover:bg-white hover:text-[#10b981]"
                )}
              >
                <History aria-hidden="true" className="size-3.5" />
                {t("columns.showHistory")}
              </Link>
            </TableCell>
            {isAdmin && (
              <TableCell className={CELL_CLASS}>
                {/* 行内删除：红色垃圾桶图标，打开确认弹窗 */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("delete")}
                  onClick={() => setDeleteTarget(city)}
                >
                  <Trash2 aria-hidden="true" className="text-destructive" />
                </Button>
              </TableCell>
            )}
          </DataTableRow>
        ))}
      </DataTable>

      {/* 删除确认弹窗：警告连带删除天气数据，确认后硬删 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("deleteConfirmDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("cancel")}
            </Button>
            <ButtonBlue
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
              }}
            >
              {deleteMutation.isPending
                ? t("deleting")
                : t("deleteConfirmConfirm")}
            </ButtonBlue>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
