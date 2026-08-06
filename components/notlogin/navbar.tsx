import { CircleUserRound, LogIn } from "lucide-react"
import Image from "next/image"
import { getTranslations } from "next-intl/server"

import icon from "@/assets/imgs/WeatherMind.png"
import { ButtonBlue } from "@/components/ui-preset/button"
import { LanguageToggle } from "@/components/ui-preset/language-toggle"
import { Link } from "@/i18n/navigation"

// 顶部导航栏：左侧品牌名，右侧登录 / 注册入口
export async function Navbar() {
  const t = await getTranslations("nav")

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
      {/* 品牌区：图标 + 大号加粗的品牌名 */}
      <div className="flex items-center gap-2">
        <Image src={icon} alt="WeatherMind" className="size-7" />
        <span className="text-2xl font-bold text-[#2563eb]">WeatherMind</span>
      </div>

      <div className="flex items-center gap-2">
        {/* 语言切换：置于登录按钮左侧 */}
        <LanguageToggle />
        {/* 登录入口：渲染成 Link 跳转登录页，保持按钮样式与语义 */}
        <ButtonBlue size="lg" nativeButton={false} render={<Link href="/login" />}>
          <CircleUserRound aria-hidden="true" />
          {t("login")}
        </ButtonBlue>
        {/* 注册入口：渲染成 Link 跳转注册页，保持按钮样式与语义 */}
        <ButtonBlue size="lg" nativeButton={false} render={<Link href="/register" />}>
          <LogIn aria-hidden="true" />
          {t("register")}
        </ButtonBlue>
      </div>
    </header>
  )
}
