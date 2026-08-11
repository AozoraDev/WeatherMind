"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { ForecastAgentPhase } from "@/lib/forecast-agent/stream/stream"
import type { ForecastAgentErrorCode } from "@/lib/forecast-agent/common/errors"
import type { ReactAction, ReactTraceStep } from "@/lib/forecast-agent/agent/react"
import type { ForecastDbRow } from "@/lib/schemas/forecast-agent"
import type { ModelConfig } from "@/lib/model-config"
import { extractDataPayloads, splitSseEvents } from "@/lib/weather/sse"

// 前端消费 /api/ai-agent/forecast 的 SSE 流：POST 发起、getReader 逐块读、
// 复用后端同款 splitSseEvents 解析，delta 逐字追加 markdown、thought 开新推理步、
// tool 实时归入当前步；rollback 把工具步的思考文字从 markdown 尾部回滚。
// 这是 rules/fetch-usage.md「客户端不裸 fetch」的受控例外：TanStack Query 面向
// 一次性快照、无法承载流式增量（queryFn 返回单一值），真流式只能 imperative fetch。

export type ForecastStreamStatus = "idle" | "streaming" | "done" | "error"

export type ForecastStreamState = {
  status: ForecastStreamStatus
  phase: ForecastAgentPhase | null
  markdown: string // 已流式累积的 Markdown 全文（含最终落库后的完整正文）
  row: ForecastDbRow | null // duplicate/done 后服务端回读的行
  errorCode: ForecastAgentErrorCode | null
  steps: ReactTraceStep[] // 流式期实时累积的轨迹步（思考文字 + 工具调用）；done 后以 row.react_trace 为准
}

type UseForecastStreamArgs = {
  cityId: string
  locale: "zh" | "en"
  model: ModelConfig | null // null = 未配置模型，start 直接报 no-model
  onDone?: (row: ForecastDbRow) => void
  onError?: (code: ForecastAgentErrorCode) => void
}

const IDLE: ForecastStreamState = {
  status: "idle",
  phase: null,
  markdown: "",
  row: null,
  errorCode: null,
  steps: [],
}

export function useForecastStream({
  cityId,
  locale,
  model,
  onDone,
  onError,
}: UseForecastStreamArgs) {
  const [state, setState] = useState<ForecastStreamState>(IDLE)
  const abortRef = useRef<AbortController | null>(null)
  const mdRef = useRef("")

  // 参数经 ref 转递：start 在异步循环里读取的是最新 cityId/locale，不依赖闭包身份
  const argsRef = useRef({ cityId, locale, model, onDone, onError })
  argsRef.current = { cityId, locale, model, onDone, onError }

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const reset = useCallback(() => {
    cancel()
    mdRef.current = ""
    setState(IDLE)
  }, [cancel])

  const start = useCallback(() => {
    const args = argsRef.current
    // 正在流式时忽略重复点击
    if (state.status === "streaming") return
    // 未配置模型：本地直接判，不发起请求。抽 const 供异步闭包内窄化（对象属性在闭包内不会收窄）
    const model = args.model
    if (!model) {
      setState({ ...IDLE, status: "error", errorCode: "no-model" })
      args.onError?.("no-model")
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    mdRef.current = ""
    setState({
      status: "streaming",
      phase: null,
      markdown: "",
      row: null,
      errorCode: null,
      steps: [],
    })

    const emitError = (code: ForecastAgentErrorCode) => {
      setState((s) => ({ ...s, status: "error", errorCode: code }))
      args.onError?.(code)
    }

    ;(async () => {
      let res: Response
      try {
        res = await fetch("/api/ai-agent/forecast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cityId: args.cityId,
            locale: args.locale,
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
        emitError("provider")
        return
      }

      // 流开始前的前置校验失败：非 2xx + JSON error 码
      if (!res.ok) {
        let code: ForecastAgentErrorCode = "generic"
        try {
          const body = (await res.json()) as { error?: string }
          if (body.error === "no-model") code = "no-model"
        } catch {
          // 非 JSON 响应按 generic 处理
        }
        emitError(code)
        return
      }
      if (!res.body) {
        emitError("provider")
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
              let ev: { type?: string }
              try {
                ev = JSON.parse(payload) as { type?: string }
              } catch {
                // 本项目服务端帧恒为合法 JSON，解析失败视为流损坏
                emitError("parse")
                return
              }
              dispatch(ev)
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return
        emitError("provider")
      } finally {
        reader.cancel().catch(() => {})
        abortRef.current = null
      }
    })()

    function dispatch(ev: { type?: string }) {
      switch (ev.type) {
        case "status": {
          setState((s) => ({
            ...s,
            phase: (ev as { phase?: ForecastAgentPhase }).phase ?? null,
          }))
          return
        }
        case "delta": {
          mdRef.current += (ev as { text: string }).text
          setState((s) => ({ ...s, markdown: mdRef.current }))
          return
        }
        case "duplicate":
        case "done": {
          const row = (ev as { row: ForecastDbRow }).row
          const md = row.markdown_body ?? mdRef.current
          mdRef.current = md
          // done 后轨迹以服务端回读行 react_trace 为准，清空流式期累积的轨迹步
          setState({
            status: "done",
            phase: null,
            markdown: md,
            row,
            errorCode: null,
            steps: [],
          })
          args.onDone?.(row)
          return
        }
        case "thought": {
          // 工具步边界 + 思考文字：开新步，后续 tool 事件归入该步（空串表示无思考文本）
          const text = (ev as { text: string }).text
          setState((s) => ({
            ...s,
            steps: [...s.steps, { thought: text, actions: [] }],
          }))
          return
        }
        case "rollback": {
          // 思考文字已按 delta 累积进 markdown，从尾部回滚（不属于最终答案正文）
          const chars = (ev as { chars: number }).chars
          mdRef.current = mdRef.current.slice(
            0,
            Math.max(0, mdRef.current.length - chars)
          )
          setState((s) => ({ ...s, markdown: mdRef.current }))
          return
        }
        case "tool": {
          const t = ev as { name: string; args: string; result: string }
          const action: ReactAction = {
            name: t.name,
            args: t.args,
            result: t.result,
          }
          setState((s) => {
            const steps = [...s.steps]
            const last = steps[steps.length - 1]
            if (last) {
              // 归入当前步（thought 事件已先开步）；无 thought 时的首个 tool 兜底走 else
              steps[steps.length - 1] = {
                ...last,
                actions: [...last.actions, action],
              }
            } else {
              steps.push({ thought: null, actions: [action] })
            }
            return { ...s, steps }
          })
          return
        }
        case "error": {
          emitError((ev as { code: ForecastAgentErrorCode }).code)
          return
        }
        default:
          // 未知事件忽略（thought/rollback/tool 已在上面 case 处理）
          return
      }
    }
  }, [state.status])

  // 卸载时中断在途请求，避免已卸载组件收到 setState
  useEffect(() => cancel, [cancel])

  return { state, start, cancel, reset }
}
