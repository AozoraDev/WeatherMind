"use client"

import type { ReactNode, Ref, UIEventHandler } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

// ForecastAgentCard / ForecastReasoningCard 共用的卡片外壳：Card 容器 + 色调渐变 + 顶部条 +
// 带状态圆点的标题 + 阶段指示 + 内容区。三档色调区分语义：success=预报结果(绿)、info=推理过程(蓝)、
// error=失败(红)。流式/终态/错误三态的差异只在 tone 与 dot 上，调用方据此组合。

// 色调：success=预报结果(绿) / info=推理过程(蓝) / error=失败(红)
type Tone = "success" | "info" | "error"

// 每档色调统一定义容器渐变、顶部条渐变、标题下边框、状态圆点颜色，避免各处散写
const TONES: Record<
  Tone,
  { card: string; bar: string; border: string; dot: string }
> = {
  success: {
    card: "bg-linear-to-r from-emerald-100/60 via-green-50/30 to-teal-100/60",
    bar: "from-emerald-400 to-green-500",
    border: "border-emerald-200/60",
    dot: "bg-emerald-500",
  },
  info: {
    card: "bg-linear-to-r from-sky-100/70 via-blue-50/40 to-indigo-100/70",
    bar: "from-sky-400 to-blue-500",
    border: "border-sky-200/60",
    dot: "bg-blue-500",
  },
  error: {
    card: "bg-linear-to-r from-red-100/50 via-rose-50/30 to-red-100/50",
    bar: "from-red-400 to-rose-500",
    border: "border-red-200/60",
    dot: "bg-red-500",
  },
}

type ForecastCardShellProps = {
  tone: Tone
  title: ReactNode
  // 标题状态圆点：streaming=琥珀脉冲（流式进行中）；Tone=对应色调实心；none=隐藏（如失败卡不带圆点）
  dot?: "streaming" | Tone | "none"
  // 流式阶段指示（标题右侧灰字）；非流式传 null 不显示
  phase?: string | null
  // Card 外层 / CardContent 附加类：限高、滚动、内容间距由调用方按需定制
  className?: string
  contentClassName?: string
  // 推理卡需要滚动容器：ref 与滚动回调透传给 CardContent，自动滚动行为留在调用方
  contentRef?: Ref<HTMLDivElement>
  onContentScroll?: UIEventHandler<HTMLDivElement>
  children: ReactNode
}

export function ForecastCardShell({
  tone,
  title,
  dot = tone,
  phase = null,
  className,
  contentClassName,
  contentRef,
  onContentScroll,
  children,
}: ForecastCardShellProps) {
  const s = TONES[tone]
  const showDot = dot !== "none" && dot != null

  return (
    <Card className={cn("overflow-hidden shadow-sm", s.card, className)}>
      <div aria-hidden="true" className={cn("h-1 shrink-0 bg-linear-to-r", s.bar)} />
      <CardHeader className={cn("shrink-0 border-b", s.border)}>
        <CardTitle className="flex items-center gap-2">
          {showDot && (
            <span
              aria-hidden="true"
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                dot === "streaming" ? "animate-pulse bg-amber-500" : s.dot
              )}
            />
          )}
          {title}
          {phase && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {phase}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent
        ref={contentRef}
        onScroll={onContentScroll}
        className={contentClassName}
      >
        {children}
      </CardContent>
    </Card>
  )
}
