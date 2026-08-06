import { type ComponentProps } from "react"

import { cn } from "@/lib/utils"

type LiquidGlassCardProps = ComponentProps<"div">

// 液态玻璃卡片预设：彩色光斑 + 磨砂玻璃层 + 顶部高光，
// 色彩透过半透明白底渗出、背景网格在毛玻璃下模糊，供登录 / 天气等卡片容器复用
export function LiquidGlassCard({
  className,
  children,
  ...props
}: LiquidGlassCardProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/50",
        "shadow-[0_8px_32px_rgba(30,41,59,0.12)]",
        className
      )}
      {...props}
    >
      {/* 彩色光斑：蓝色光源，放大模糊后形成液态流动色，置于玻璃层之下 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-16 -left-16 size-40 rounded-full bg-[#2563eb]/40 blur-3xl"
      />
      {/* 磨砂玻璃层：淡蓝到白色自上而下渐变 + 背景模糊，顶部一条内高光模拟玻璃折射边缘 */}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 bg-linear-to-b from-sky-100/60 to-white/60 backdrop-blur-xl",
          "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-1/2",
          "before:bg-linear-to-b before:from-white/60 before:to-transparent"
        )}
      />
      {/* 内容置于玻璃之上 */}
      <div className="relative">{children}</div>
    </div>
  )
}
