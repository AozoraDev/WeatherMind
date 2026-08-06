import { type ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type PresetButtonProps = ComponentProps<typeof Button>

// 品牌蓝色主按钮预设：蓝底白字，hover 变亮，供页面统一复用
export function ButtonBlue({ className, ...props }: PresetButtonProps) {
  return (
    <Button
      className={cn("bg-[#2563eb] text-white hover:bg-[#3B82F6]", className)}
      {...props}
    />
  )
}

// 品牌绿色次按钮预设：绿底白字，hover 白底绿字，供页面统一复用
export function ButtonGreen({ className, ...props }: PresetButtonProps) {
  return (
    <Button
      className={cn(
        "bg-[#10b981] text-white hover:bg-white hover:text-[#10b981]",
        className
      )}
      {...props}
    />
  )
}
