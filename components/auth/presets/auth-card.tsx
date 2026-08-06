import { type ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import Image from "next/image"
import { getTranslations } from "next-intl/server"

import aozoraIcon from "@/assets/imgs/AozoraDev.png"
import weatherIcon from "@/assets/imgs/WeatherMind.png"
import { GridBackground } from "@/components/ui-preset/grid-background"
import { LanguageToggle } from "@/components/ui-preset/language-toggle"
import { LiquidGlassCard } from "@/components/ui-preset/liquid-glass-card"
import { ButtonBlue } from "@/components/ui-preset/button"
import { Link } from "@/i18n/navigation"

type AuthCardProps = {
  title: string
  subtitle: string
  children: ReactNode
}

// 鉴权页统一外壳：顶部工具条（返回未登录页 + 语言切换）+ 网格背景 + 居中液态玻璃卡片
export async function AuthCard({ title, subtitle, children }: AuthCardProps) {
  const t = await getTranslations("nav")

  return (
    <GridBackground className="flex min-h-svh flex-col">
      {/* 顶部工具条：左侧返回未登录页，右侧语言切换，中间居中品牌区 */}
      <header className="relative flex h-14 shrink-0 items-center justify-between border-b bg-white px-4">
        <ButtonBlue
          size="sm"
          nativeButton={false}
          render={<Link href="/notlogin" />}
        >
          <ArrowLeft aria-hidden="true" />
          {t("back")}
        </ButtonBlue>

        {/* 居中品牌区：WeatherMind 标题 + logo，灰色竖线分隔后接 AozoraDev logo */}
        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
          <span className="text-lg font-bold text-[#2563eb]">WeatherMind</span>
          <Image src={weatherIcon} alt="WeatherMind" className="size-5" />
          <div aria-hidden="true" className="h-5 w-px bg-slate-300" />
          <Image src={aozoraIcon} alt="AozoraDev" className="size-5" />
        </div>

        <LanguageToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-4">
        <LiquidGlassCard className="w-full max-w-sm p-8">
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-semibold text-[#2563eb]">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="mt-6">{children}</div>
        </LiquidGlassCard>
      </main>
    </GridBackground>
  )
}
