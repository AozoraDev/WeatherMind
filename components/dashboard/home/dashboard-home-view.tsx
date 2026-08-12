import {
  ArrowRight,
  Bot,
  CloudSun,
  History,
  MapPin,
  ScrollText,
  Settings,
  type LucideIcon,
} from "lucide-react"
import { getLocale, getTranslations } from "next-intl/server"

import { Link } from "@/i18n/navigation"
import { cn } from "@/lib/utils"

// 功能入口卡配置：key 对应 i18n 文案；图标块配色 + 顶部饰条渐变按各页主题区分；
// adminOnly 的卡仅管理员可见（与侧栏「日志」入口显隐口径一致）
type HomeCard = {
  key: "aiAgent" | "forecast" | "history" | "cities" | "logs" | "settings"
  href: string
  icon: LucideIcon
  chip: string
  bar: string
  adminOnly?: boolean
}

const CARDS: HomeCard[] = [
  {
    key: "aiAgent",
    href: "/dashboard/ai-agent",
    icon: Bot,
    chip: "bg-violet-100 text-violet-600",
    bar: "from-violet-400 to-purple-500",
  },
  {
    key: "forecast",
    href: "/dashboard/forecast",
    icon: CloudSun,
    chip: "bg-sky-100 text-sky-600",
    bar: "from-sky-400 to-blue-500",
  },
  {
    key: "history",
    href: "/dashboard/history",
    icon: History,
    chip: "bg-amber-100 text-amber-600",
    bar: "from-amber-400 to-orange-500",
  },
  {
    key: "cities",
    href: "/dashboard/cities",
    icon: MapPin,
    chip: "bg-emerald-100 text-emerald-600",
    bar: "from-emerald-400 to-green-500",
  },
  {
    key: "logs",
    href: "/dashboard/logs",
    icon: ScrollText,
    chip: "bg-rose-100 text-rose-600",
    bar: "from-rose-400 to-pink-500",
    adminOnly: true,
  },
  {
    key: "settings",
    href: "/dashboard/settings",
    icon: Settings,
    chip: "bg-slate-100 text-slate-600",
    bar: "from-slate-400 to-slate-500",
  },
]

// 仪表盘首页总览（服务端组件）：欢迎横幅（渐变底 + 装饰光斑 + 今日日期）+
// 功能入口卡片网格，作为登录后第一屏承接各子页入口；
// 日期固定东京时区格式化，避免服务端/客户端时区差异导致文案漂移
export async function DashboardHomeView({ isAdmin }: { isAdmin: boolean }) {
  const t = await getTranslations("dashboard.home")
  const locale = await getLocale()
  const today = new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeZone: "Asia/Tokyo",
  }).format(new Date())

  const visible = CARDS.filter((card) => !card.adminOnly || isAdmin)

  return (
    <div className="flex flex-col gap-6">
      {/* 欢迎横幅：蓝紫渐变底，右上/左下装饰光斑，标题承接「仪表盘」，副文案说明平台定位 */}
      <section className="relative overflow-hidden rounded-2xl border border-sky-200/60 bg-linear-to-r from-sky-100/80 via-blue-50/50 to-indigo-100/80 px-6 py-5 shadow-sm">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-8 -top-12 size-44 rounded-full bg-[#2563eb]/15 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-14 right-28 size-36 rounded-full bg-emerald-400/10 blur-3xl"
        />
        <p className="text-xs font-semibold uppercase tracking-wider text-[#2563eb]">
          {today}
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">
          {t("hero.title")}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t("hero.desc")}
        </p>
      </section>

      {/* 快捷入口：响应式卡片网格，hover 上浮 + 箭头右移；色带与各子页主题对应 */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map(({ key, href, icon: Icon, chip, bar }) => (
          <Link
            key={key}
            href={href}
            className="group relative flex flex-col gap-4 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#2563eb]/40 hover:shadow-md"
          >
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-x-0 top-0 h-0.5 bg-linear-to-r",
                bar
              )}
            />
            <div className="flex items-start justify-between">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-10 items-center justify-center rounded-xl",
                  chip
                )}
              >
                <Icon className="size-5" />
              </span>
              <ArrowRight
                aria-hidden="true"
                className="mt-1 size-4 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#2563eb]"
              />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground">
                {t(`cards.${key}.label`)}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {t(`cards.${key}.desc`)}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
