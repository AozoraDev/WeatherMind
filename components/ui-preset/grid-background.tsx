import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

type GridBackgroundProps = ComponentProps<"div">

// 网格背景预设：浅灰底（#f8fafc）+ 细方格纹理，供内容区页面背景统一复用
export function GridBackground({
  className,
  children,
  ...props
}: GridBackgroundProps) {
  return (
    <div
      className={cn(
        "bg-[#f8fafc]",
        // 上下两道 1px 网格线，模拟纸张方格纹理
        "bg-[linear-gradient(to_right,rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.12)_1px,transparent_1px)]",
        "bg-size-[36px_36px]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
