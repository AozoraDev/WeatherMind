"use client"

import { useLocale } from "next-intl"

import { Button } from "@/components/ui/button"
import { usePathname, useRouter } from "@/i18n/navigation"
import { routing } from "@/i18n/routing"
import { cn } from "@/lib/utils"

// 语言切换预设：整体绿色胶囊，选中项白底绿字；点击切换中/英文并替换当前路由
export function LanguageToggle({ className }: { className?: string }) {
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()

  // 切换语言：目标语言与当前一致时跳过，用 replace 避免产生多余历史记录
  function onSwitch(nextLocale: string) {
    if (nextLocale === locale) return
    router.replace(pathname, { locale: nextLocale })
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-full bg-[#10b981] p-1",
        className
      )}
    >
      {routing.locales.map((loc) => {
        const active = loc === locale
        return (
          <Button
            key={loc}
            size="sm"
            aria-pressed={active}
            onClick={() => onSwitch(loc)}
            className={cn(
              "rounded-full border-transparent bg-transparent text-white hover:bg-white/10",
              active && "bg-white text-[#10b981] shadow-sm hover:bg-white"
            )}
          >
            {loc === "zh" ? "中文" : "EN"}
          </Button>
        )
      })}
    </div>
  )
}
