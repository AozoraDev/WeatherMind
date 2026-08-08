"use client"

import { Fragment } from "react"
import { useTranslations } from "next-intl"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { LanguageToggle } from "@/components/ui-preset/language-toggle"
import { Link, usePathname } from "@/i18n/navigation"

import { LogoutButton } from "./logout-button"

// 面包屑节点：href 为跳转链接，isCurrent 表示是否为当前页（不可点击）
type Crumb = { label: string; href: string; isCurrent: boolean }

// 仪表盘顶部导航：左侧面包屑 + 右侧语言切换、用户邮箱、退出登录按钮
export function DashboardNavbar({ email }: { email: string }) {
  const t = useTranslations("dashboard")
  const pathname = usePathname()

  // 路径段 → 侧边栏文案的映射，路径未知时跳过该段
  const sectionLabels: Record<string, string> = {
    dashboard: t("sidebar.dashboard"),
    "ai-agent": t("sidebar.aiAgent"),
    cities: t("sidebar.cities"),
    forecast: t("sidebar.forecast"),
    history: t("sidebar.history"),
    logs: t("sidebar.logs"),
    settings: t("sidebar.settings"),
  }

  // 按路径层级生成面包屑：首页「仪表盘」为链接，末级为当前页
  const segments = pathname.split("/").filter(Boolean)
  const crumbs: Crumb[] = segments.flatMap((seg, i) => {
    const label = sectionLabels[seg]
    if (!label) return []
    const href = "/" + segments.slice(0, i + 1).join("/")
    return [{ label, href, isCurrent: i === segments.length - 1 }]
  })

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4">
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, i) => (
            <Fragment key={crumb.href}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {crumb.isCurrent ? (
                  <BreadcrumbPage className="font-semibold text-[#2563eb]">
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    className="font-semibold text-[#2563eb] hover:text-[#1d4ed8]"
                    render={<Link href={crumb.href} />}
                  >
                    {crumb.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex items-center gap-3">
        <LanguageToggle />
        <span className="text-sm font-medium text-slate-700">{email}</span>
        <LogoutButton email={email} />
      </div>
    </header>
  )
}
