"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { ModelConfig } from "@/lib/model-config"
import { extractDataPayloads, splitSseEvents } from "@/lib/weather/sse"

// 前端消费 /api/ai-agent/* SSE 流的通用传输层：POST 发起、getReader 逐块读、
// 复用后端同款 splitSseEvents 解析，逐事件回调 onEvent（具体 hook 更新各自内容 state）。
// 状态机（idle/streaming/done/error）+ AbortController + 断网兜底 + 错误码映射都收敛在这里，
// useForecastStream / useChatStream 只保留「事件 → 内容」的分发。
// 这是 rules/fetch-usage.md「客户端不裸 fetch」的受控例外：真流式 TanStack Query 无法承载。

export type SseStreamStatus = "idle" | "streaming" | "done" | "error"

export type SseStreamState<TError extends string> = {
  status: SseStreamStatus
  errorCode: TError | null
}

// 传输层上下文：markDone 置终态 done，fail 置 error + errorCode 并触发 onError
export type SseStreamCtx<TError extends string> = {
  markDone: () => void
  fail: (code: TError) => void
}

export type UseSseStreamOptions<TArgs, TError extends string, TEvent> = {
  url: string
  model: ModelConfig | null // null = 未配置模型，start 直接报 no-model
  // 用 start 参数拼请求体业务字段（model 由传输层统一附加）
  buildBody: (params: TArgs) => Record<string, unknown>
  onTransportError: TError // fetch 抛错（非 Abort）
  onNoBodyError: TError // 响应无 body
  onParseError: TError // 流帧 JSON 解析失败
  decodeError: (bodyError: string | undefined) => TError // 非 2xx 响应的 error 字段
  onEvent: (event: TEvent, ctx: SseStreamCtx<TError>) => void // 事件 → 具体内容 state
  onReset?: () => void // reset 时清内容 ref/state
  onError?: (code: TError) => void
}

// 未配置模型是各调用方共用的本地判定，错误码统一 no-model（具体 hook 的错误码 union 均含它）
const NO_MODEL = "no-model"

export function useSseStream<TArgs, TError extends string, TEvent>(
  opts: UseSseStreamOptions<TArgs, TError, TEvent>
): {
  status: SseStreamStatus
  errorCode: TError | null
  start: (params: TArgs) => void
  cancel: () => void
  reset: () => void
} {
  const [state, setState] = useState<SseStreamState<TError>>({
    status: "idle",
    errorCode: null,
  })
  const abortRef = useRef<AbortController | null>(null)

  // 参数经 ref 转递：start 的异步循环读最新 opts，不依赖闭包身份。
  // 放 effect 里同步而非渲染期赋值（react-hooks/refs 禁渲染期写 ref）；事件处理器
  // 都在 effect 之后触发，读到的恒为最新 opts
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const reset = useCallback(() => {
    cancel()
    optsRef.current.onReset?.()
    setState({ status: "idle", errorCode: null })
  }, [cancel])

  const start = useCallback(
    (params: TArgs) => {
      const current = optsRef.current
      // 在途请求未结束前忽略重复触发（ref 判定跨渲染可靠，防快速连点双请求）
      if (abortRef.current) return
      // 未配置模型：本地直接判，不发起请求。抽 const 供异步闭包内窄化
      const model = current.model
      if (!model) {
        setState({ status: "error", errorCode: NO_MODEL as TError })
        current.onError?.(NO_MODEL as TError)
        return
      }

      // 新一轮请求：先清上一轮累积的内容（错误后重试/连续多轮时，防残留拼接到新回复）
      current.onReset?.()

      const controller = new AbortController()
      abortRef.current = controller

      // settled：本轮是否已收到终态事件（done/error）。流关闭后据此判断是否异常中断
      let settled = false
      const markDone = () => {
        settled = true
        setState((s) => ({ ...s, status: "done" }))
      }
      const fail = (code: TError) => {
        settled = true
        setState((s) => ({ ...s, status: "error", errorCode: code }))
        current.onError?.(code)
      }
      const ctx: SseStreamCtx<TError> = { markDone, fail }

      setState({ status: "streaming", errorCode: null })

      ;(async () => {
        try {
          let res: Response
          try {
            res = await fetch(current.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...current.buildBody(params),
                model: {
                  baseUrl: model.baseUrl,
                  apiKey: model.apiKey,
                  model: model.model,
                },
              }),
              signal: controller.signal,
              cache: "no-store",
            })
          } catch {
            // 断网/Abort：Abort 是主动取消（cancel/reset），不算错误
            if (controller.signal.aborted) return
            fail(current.onTransportError)
            return
          }

          // 流开始前的前置校验失败：非 2xx + JSON error 码
          if (!res.ok) {
            let code = current.decodeError(undefined)
            try {
              const body = (await res.json()) as { error?: string }
              code = current.decodeError(body.error)
            } catch {
              // 非 JSON 响应按 decodeError(undefined) 兜底
            }
            fail(code)
            return
          }
          if (!res.body) {
            fail(current.onNoBodyError)
            return
          }

          // 逐块读 SSE：splitSseEvents 切完整帧，extractDataPayloads 剥 data: 壳
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const { blocks, rest } = splitSseEvents(buffer)
              buffer = rest
              for (const block of blocks) {
                for (const payload of extractDataPayloads(block)) {
                  let ev: TEvent
                  try {
                    ev = JSON.parse(payload) as TEvent
                  } catch {
                    // 本项目服务端帧恒为合法 JSON，解析失败视为流损坏
                    fail(current.onParseError)
                    return
                  }
                  current.onEvent(ev, ctx)
                }
              }
            }
          } catch {
            if (controller.signal.aborted) return
            fail(current.onTransportError)
          } finally {
            reader.cancel().catch(() => {})
          }
          // 流正常关闭但未收到终态事件（服务端异常断开/代理掐断/响应被截断）：
          // 不兜底会永远卡在 streaming、按钮禁用，故归传输错误并触发 onError。
          // 主动 cancel/reset 的 Abort 不在此列（aborted 守卫）
          if (!settled && !controller.signal.aborted) {
            fail(current.onTransportError)
            return
          }
        } finally {
          // 清在途标记：仅当仍是本控制器时清（防旧循环清理误清新一轮请求）
          if (abortRef.current === controller) abortRef.current = null
        }
      })()
    },
    // 只依赖 ref 与稳定 setState，无需随 state 变化重建；在途判定走 abortRef
    []
  )

  // 卸载时中断在途请求，避免已卸载组件收到 setState
  useEffect(() => cancel, [cancel])

  return { status: state.status, errorCode: state.errorCode, start, cancel, reset }
}
