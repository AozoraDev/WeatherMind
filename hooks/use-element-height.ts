"use client"

import { useLayoutEffect, useRef, useState } from "react"

// 观测目标元素实时高度（ResizeObserver）：返回 ref（绑到目标容器）与高度 px。
// 用于预报页让右列 AI 推理卡与左列城市卡等高；窗口缩放/内容变化自动更新，
// useLayoutEffect 保证首帧前完成测量，避免初始无高度造成的闪烁。
export function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setHeight(el.offsetHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return { ref, height }
}
