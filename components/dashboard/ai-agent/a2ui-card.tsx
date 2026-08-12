"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { MessageProcessor } from "@a2ui/web_core/v0_9"
import { A2uiSurface } from "@a2ui/react/v0_9"
import { injectStyles } from "@a2ui/react/styles"

import { aiAgentCatalog } from "@/components/dashboard/ai-agent/a2ui-catalog"
import type { A2uiMessages } from "@/lib/schemas/a2ui"

// 渲染一张 a2ui 卡片（客户端）：每条消息一个独立 MessageProcessor（卡片静态，无需跨消息
// 共享 processor），消息入 processor 后订阅 surface 创建/删除事件同步 surface 列表，
// 再以 <A2uiSurface> 渲染原生组件。processor 用自定义 catalog（basicCatalog + MetricTile）。
// 样式需宿主注入结构 CSS（injectStyles 幂等，只注入一次）。
// processMessages 以 processedRef 防重复执行（React 19 StrictMode 开发期双挂载 + 流式期
// 消息从空到实的变化都会触发 effect，重复处理同一条 createSurface 可能抛错，故仅在消息引用
// 变化时处理一次，异常整体降级为空渲染）。

// 借 forecast-agent 结果卡（ForecastCardShell 成功态）的视觉语言：绿色渐变容器 + 顶部色条 +
// 圆角边框阴影。服务端模板新版卡片根节点为 Column（无 Card），背景透明、渐变透出；DB 里旧的
// Card 根节点消息默认带不透明 surface 背景/边框/外边距，这里用 CSS 变量归零，保持观感一致。

let stylesInjected = false

function ensureA2uiStyles() {
  // SSR 时 window 未定义，跳过；客户端首次挂载注入一次
  if (typeof window !== "undefined" && !stylesInjected) {
    injectStyles()
    stylesInjected = true
  }
}

export function A2uiCard({ messages }: { messages: A2uiMessages }) {
  const [processor] = useState(() => new MessageProcessor([aiAgentCatalog]))
  const [surfaces, setSurfaces] = useState(() =>
    Array.from(processor.model.surfacesMap.values())
  )
  const processedRef = useRef<A2uiMessages | null>(null)

  useEffect(() => {
    ensureA2uiStyles()
    const sync = () =>
      setSurfaces(Array.from(processor.model.surfacesMap.values()))
    const created = processor.onSurfaceCreated(sync)
    const deleted = processor.onSurfaceDeleted(sync)

    if (processedRef.current !== messages) {
      processedRef.current = messages
      try {
        processor.processMessages(messages)
      } catch {
        // 消息结构异常（版本漂移等）：整卡降级为空，不阻塞聊天
      }
    }
    sync()

    return () => {
      created.unsubscribe()
      deleted.unsubscribe()
    }
  }, [processor, messages])

  if (surfaces.length === 0) return null

  // 借 forecast-agent 结果卡片（ForecastCardShell 成功态）的视觉语言：绿色渐变容器 + 顶部色条
  // + 圆角边框阴影，让聊天里的卡片与预报页结果卡观感一致。当前只有「预报指标卡」一种 a2ui
  // 消息，语义即成功态；后续引入其他卡片时按消息类型扩展色调。
  return (
    <div
      className="mt-2 overflow-hidden rounded-xl border border-emerald-200/60 bg-linear-to-r from-emerald-100/60 via-green-50/30 to-teal-100/60 shadow-sm"
      style={
        {
          // 旧 Card 根节点消息默认带不透明 surface 背景/边框/外边距，归零让绿色渐变透出
          "--a2ui-card-background": "transparent",
          "--a2ui-card-border": "none",
          "--a2ui-card-padding": "0",
          "--a2ui-card-margin": "0",
          "--a2ui-card-box-shadow": "none",
        } as CSSProperties
      }
    >
      <div
        aria-hidden="true"
        className="h-1 shrink-0 bg-linear-to-r from-emerald-400 to-green-500"
      />
      <div className="px-4 py-3">
        {surfaces.map((surface) => (
          <A2uiSurface key={surface.id} surface={surface} />
        ))}
      </div>
    </div>
  )
}
