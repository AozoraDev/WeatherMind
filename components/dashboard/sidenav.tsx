"use client"

import {
  Bot,
  CloudSun,
  History,
  LayoutDashboard,
  MapPin,
  ScrollText,
  Settings,
  type LucideIcon,
} from "lucide-react"
import Image from "next/image"
import { useTranslations } from "next-intl"

import icon from "@/assets/imgs/WeatherMind.png"
import { Link, usePathname } from "@/i18n/navigation"
import { cn } from "@/lib/utils"

// 侧边导航：固定 w-56 宽度，顶部品牌区 + 图标导航列表；列表项图标在左、文案在右
export function Sidenav({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("dashboard")
  const pathname = usePathname()

  // 导航项配置：href 为空表示功能未上线，渲染为禁用占位；
  // 「日志」仅管理员可见（页面层另有重定向守卫双保险）
  const items: { label: string; href?: string; icon: LucideIcon }[] = [
    {
      label: t("sidebar.dashboard"),
      href: "/dashboard",
      icon: LayoutDashboard,
    },
    { label: t("sidebar.aiAgent"), href: "/dashboard/ai-agent", icon: Bot },
    { label: t("sidebar.cities"), href: "/dashboard/cities", icon: MapPin },
    {
      label: t("sidebar.forecast"),
      href: "/dashboard/forecast",
      icon: CloudSun,
    },
    { label: t("sidebar.history"), href: "/dashboard/history", icon: History },
    ...(isAdmin
      ? [{ label: t("sidebar.logs"), href: "/dashboard/logs", icon: ScrollText }]
      : []),
    {
      label: t("sidebar.settings"),
      href: "/dashboard/settings",
      icon: Settings,
    },
  ]

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-8 border-r border-slate-200 bg-[#f2f3f7] p-6">
      {/* 品牌区：图标 + 蓝色加粗品牌名 */}
      <div className="flex items-center justify-center gap-2">
        <Image src={icon} alt="WeatherMind" className="size-7" />
        <span className="text-xl font-bold text-[#2563eb]">WeatherMind</span>
      </div>

      <nav className="flex flex-col gap-1">
        {items.map(({ label, href, icon: Icon }) => {
          // 未上线功能：置灰不可点，示意占位
          if (!href) {
            return (
              <div
                key={label}
                className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400"
              >
                <Icon aria-hidden="true" className="size-5" />
                {label}
              </div>
            )
          }
          const active = href === pathname
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-white text-[#2563eb] shadow-sm"
                  : "text-slate-600 hover:bg-white/60 hover:text-slate-900"
              )}
            >
              <Icon aria-hidden="true" className="size-5" />
              {label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
