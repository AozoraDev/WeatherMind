import { Layers, Sparkles } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { ButtonBlue, ButtonGreen } from "@/components/ui-preset/button"
import { GridBackground } from "@/components/ui-preset/grid-background"
import { LiquidGlassCard } from "@/components/ui-preset/liquid-glass-card"
import { Link } from "@/i18n/navigation"

// GitHub 品牌图标：lucide 已移除品牌图标，内联 SVG 保持风格统一
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

// 主体内容：未登录状态下的产品介绍与注册引导
export async function Body() {
  const t = await getTranslations("landing")

  return (
    <main className="flex flex-1 flex-col">
      <GridBackground className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-12 text-center">
        <div className="flex flex-col items-center gap-3">
          <h1 className="text-5xl font-semibold tracking-tight text-[#2563eb]">
            {t("title")}
          </h1>
          <p className="max-w-md text-lg text-muted-foreground">
            {t("subtitle")}
          </p>

          {/* 操作入口：蓝色引导登录，绿色跳转 GitHub 仓库 */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            {/* 登录启动仪表盘：渲染成 Link 跳转登录页 */}
            <ButtonBlue size="lg" nativeButton={false} render={<Link href="/login" />}>
              {t("launchDashboard")}
            </ButtonBlue>
            {/* GitHub 仓库：外链新窗口打开，render 成 <a> 保持按钮样式；nativeButton 置 false 以匹配非按钮语义 */}
            <ButtonGreen
              size="lg"
              nativeButton={false}
              render={<a href="https://github.com/AozoraDev/WeatherMind" target="_blank" rel="noopener noreferrer" />}
            >
              <GithubIcon />
              {t("github")}
            </ButtonGreen>
          </div>
        </div>

        {/* 产品亮点：两张液态玻璃卡片，左 40% 数据源融合、右 60% 个性化建议 */}
        <div className="grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-10">
          <LiquidGlassCard className="col-span-1 flex flex-col justify-center gap-3 p-6 text-left md:col-span-4">
            <div className="flex items-center gap-5">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#2563eb]/10 text-[#2563eb]">
                <Layers className="size-6" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">{t("fusionTitle")}</h3>
            </div>
            <p className="pl-16 text-sm text-muted-foreground">{t("fusionDesc")}</p>
          </LiquidGlassCard>

          <LiquidGlassCard className="col-span-1 flex flex-col justify-center gap-3 p-6 text-left md:col-span-6">
            <div className="flex items-center gap-5">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#10b981]/10 text-[#10b981]">
                <Sparkles className="size-6" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">{t("adviceTitle")}</h3>
            </div>
            <p className="pl-16 text-sm text-muted-foreground">{t("adviceDesc")}</p>
          </LiquidGlassCard>
        </div>
      </GridBackground>
    </main>
  )
}
