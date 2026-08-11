import type { SupabaseClient } from "@supabase/supabase-js"

import { validateMarkdownDoc, type ForecastDbRow } from "@/lib/schemas/forecast-agent"
import { toLocalDateKey } from "@/lib/weather/daily"

import {
  readForecast,
  claimPending,
  settleRow,
  buildSourceInputs,
  isWithinRetryCooldown,
} from "../db/db"
import { FORMULA_VERSION, predict } from "../engine/ensemble"
import type { ForecastAgentErrorCode } from "../common/errors"
import { buildForecastAgentMessages } from "../agent/prompt"
import type { ReactLoopResult } from "../agent/react"
import { runReActLoopStream } from "../agent/react-stream"
import { buildTools } from "../agent/tools"
import { computeWeights } from "../engine/weights"

// —— 流式编排（真流式 Markdown 输出） ——
// 唯一生成入口（非流式 runForecastAgent 已随 core 路径废弃删除）：读既有→去重（duplicate）、认领→集成→流式 ReAct→轻量校验→settle，
// 事件逐个产出供 Route Handler 转 SSE。生成期失败统一落库为 failed + failed_at（冷却计时，5 分钟内同 城×日×语言 禁重试），
// 成功行才留终态；失败以带内 error 事件返回。纯 Markdown 输出走 validateMarkdownDoc 轻量校验（不再有结构化 points）
export type ForecastAgentPhase =
  "start" | "read" | "claim" | "ensemble" | "agent" | "validate" | "settle"

export type ForecastAgentStreamEvent =
  | { type: "status"; phase: ForecastAgentPhase }
  | { type: "delta"; text: string } // Markdown 增量（透传 runReActLoopStream 最终步）
  | { type: "thought"; text: string } // 工具步模型思考文字（推理卡展示；空串表示步边界）
  | { type: "rollback"; chars: number } // 思考文字已按 delta 透传，客户端据此从 Markdown 回滚
  | { type: "tool"; name: string; args: string; result: string } // 某工具已执行（含观察结果，透传）
  | { type: "duplicate"; row: ForecastDbRow } // 已存在行，不重复生成
  | { type: "done"; row: ForecastDbRow } // 成功落库后回读的行
  | { type: "error"; code: ForecastAgentErrorCode }

export async function* runForecastAgentStream(
  session: SupabaseClient,
  service: SupabaseClient,
  params: {
    cityId: string
    email: string
    locale: "zh" | "en"
    model: { baseUrl: string; apiKey: string; model: string }
    signal?: AbortSignal
  }
): AsyncGenerator<ForecastAgentStreamEvent> {
  const { cityId, email, locale, model, signal } = params

  // 认领行生命周期：记录是否已认领、是否已成功落库、是否已显式回滚。
  // 客户端断开/未预期异常时由 finally 兜底删除仍为 pending 的行，防当日城×日×语言被卡死
  let claimedRowId: string | null = null
  let settledSuccess = false
  let cleanedUp = false

  try {
    // 断线（signal aborted）时不开始新生成，直接走 catch → finally
    if (signal?.aborted) throw new Error("client-aborted")
    yield { type: "status", phase: "start" }

    // 城市与时区：当天日期按城市本地日算，跨源对账基准
    const cityRes = await session
      .from("cities")
      .select("*")
      .eq("id", cityId)
      .eq("is_active", true)
      .maybeSingle()
    const city = cityRes.data as {
      name_ja: string
      name_en: string
      timezone: string
    } | null
    if (!city) {
      yield { type: "error", code: "generic" }
      return
    }
    const day = toLocalDateKey(new Date().toISOString(), city.timezone)

    // success/pending 终态 → duplicate 直接返回（不重复生成）；failed 走冷却判定后认领重试
    yield { type: "status", phase: "read" }
    const existing = await readForecast(session, cityId, day, locale)
    if (existing && existing.status !== "failed") {
      yield { type: "duplicate", row: existing }
      return
    }
    // 失败冷却：failed 行 5 分钟内禁止重试（防失败重试无限刷服务器），冷却期过后才认领重试
    if (
      existing &&
      existing.status === "failed" &&
      isWithinRetryCooldown(existing.failed_at, Date.now())
    ) {
      yield { type: "error", code: "retry-cooldown" }
      return
    }

    // 认领：失败（他人已认领/写入错误）→ duplicate（他人行）；冲突读回既有行
    yield { type: "status", phase: "claim" }
    const claim = await claimPending(service, cityId, day, locale, email)
    if (!claim) {
      yield { type: "error", code: "generic" }
      return
    }
    if (!claim.claimed) {
      yield { type: "duplicate", row: claim.row }
      return
    }
    claimedRowId = claim.row.id

    // 生成期失败统一落库为 failed + failed_at（失败冷却计时起点，5 分钟内同 城×日×语言 禁重试）。
    // 不再删除——失败记录要保留供冷却判定；settle 失败兜底删行，避免 pending 行永久卡死。
    // 处理成功后置 cleanedUp，finally 不再重复处理本行
    const rollback = async (
      errorCode: ForecastAgentErrorCode
    ): Promise<{ type: "error"; code: ForecastAgentErrorCode }> => {
      const ok = await settleRow(service, claim.row.id, {
        status: "failed",
        error_code: errorCode,
        failed_at: new Date().toISOString(),
      })
      if (!ok) {
        await service
          .from("forecast_agent_predictions")
          .delete()
          .eq("id", claim.row.id)
      }
      cleanedUp = true
      return { type: "error", code: errorCode }
    }

    const inputs = await buildSourceInputs(session, cityId, day)
    // 至少两源当日数据才算有效集成，单源不给出确定性结论
    if (inputs.length < 2) {
      yield await rollback("insufficient-data")
      return
    }

    yield { type: "status", phase: "ensemble" }
    const weights = await computeWeights(session)
    const result = predict(inputs, weights)

    yield { type: "status", phase: "agent" }
    // 断线时不发起昂贵的 AI 调用：直接抛出让 catch/finally 结束并清理
    if (signal?.aborted) throw new Error("client-aborted")
    const messages = buildForecastAgentMessages(
      { nameJa: city.name_ja, nameEn: city.name_en },
      day,
      result,
      locale
    )
    // 流式 ReAct：工具步内部执行（yield tool 提示），最终步逐 delta 产出 Markdown 全文
    let loopResult: ReactLoopResult | null = null
    for await (const ev of runReActLoopStream({
      model: {
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
      },
      messages,
      tools: buildTools({ result, locale }),
      timeoutMs: 45_000,
      maxSteps: 4,
      // 实时进度：每步把部分轨迹写回本次认领的行（service_role 写）；写失败静默降级
      onTrace: async (trace) => {
        try {
          await settleRow(service, claim.row.id, { react_trace: trace })
        } catch {
          // 进度写失败仅丢失实时轨迹，不中止推理
        }
      },
    })) {
      if (ev.type === "delta") yield { type: "delta", text: ev.text }
      else if (ev.type === "thought") yield { type: "thought", text: ev.text }
      else if (ev.type === "rollback")
        yield { type: "rollback", chars: ev.chars }
      else if (ev.type === "tool")
        yield { type: "tool", name: ev.name, args: ev.args, result: ev.result }
      else if (ev.type === "result") {
        loopResult = ev.result
        break
      }
    }

    // react-loop = 循环步数耗尽未收敛；其余 provider 类错误统一归 provider
    if (!loopResult || !loopResult.ok) {
      yield await rollback(
        loopResult?.error === "react-loop" ? "react-loop" : "provider"
      )
      return
    }
    const usage = loopResult.usage

    // 纯 Markdown 输出：轻量校验（两段齐 + 关键数值与集成一致 + 防胡编）。
    // 校验在全文流完后才跑，失败时文档已展示给用户、随后收 error:consistency（行不落库）
    yield { type: "status", phase: "validate" }
    const validation = validateMarkdownDoc(loopResult.content, result)
    if (!validation.ok) {
      yield await rollback("consistency")
      return
    }

    yield { type: "status", phase: "settle" }
    const ok = await settleRow(service, claim.row.id, {
      status: "success",
      predicted_high: result.high,
      predicted_low: result.low,
      high_interval: result.highInterval,
      low_interval: result.lowInterval,
      precipitation_probability: result.poP,
      precip_level: result.precipLevel,
      condition: result.condition,
      wind_beaufort: result.windBeaufort,
      wind_speed: result.windMs,
      humidity: result.humidity,
      confidence: result.confidence,
      risk_flags: result.riskFlags,
      weights: result.weights,
      source_inputs: result.sourceInputs,
      formula_version: FORMULA_VERSION,
      model: model.model,
      prompt_tokens: usage?.prompt_tokens ?? null,
      completion_tokens: usage?.completion_tokens ?? null,
      react_trace: loopResult.trace,
      markdown_body: loopResult.content,
      error_code: null,
    })
    if (!ok) {
      yield await rollback("generic")
      return
    }
    // 已成功落库：标记后 finally 不再清理本行
    settledSuccess = true

    // settle 成功后回读失败**不能** rollback——那会删掉一条已成功的行；
    // 直接报 generic 结束（行已留库，重试会读到 success 走 duplicate）
    const row = await readForecast(session, cityId, day, locale)
    if (!row) {
      yield { type: "error", code: "generic" }
      return
    }
    yield { type: "done", row }
  } catch {
    // 任何未预期异常：兜底为 generic（清理统一交 finally）
    yield { type: "error", code: "generic" }
  } finally {
    // 兜底清理：认领过、但既未成功落库也未显式回滚的行（客户端断开/未预期中断），
    // 尽力删除防 pending 卡死当日城×日×语言；删除失败 settle 为 failed（可重试）。
    // 成功行（settledSuccess）与已回滚行（cleanedUp）不动
    if (claimedRowId && !settledSuccess && !cleanedUp) {
      const { error } = await service
        .from("forecast_agent_predictions")
        .delete()
        .eq("id", claimedRowId)
      if (error) {
        await settleRow(service, claimedRowId, {
          status: "failed",
          error_code: "generic",
        })
      }
    }
  }
}
