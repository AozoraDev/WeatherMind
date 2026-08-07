"use server"

import { createClient } from "@/supabase/server"

import { isAdminEmail } from "./admin"
import {
  runWeatherBackfill,
  runWeatherPipeline,
  type RunSummary,
} from "./pipeline"
import type { WeatherErrorCode } from "./errors"

// 手动刷新动作结果：成功带运行摘要，失败受限错误码；从不抛错（镜像 auth/actions）
export type RefreshWeatherResult =
  { ok: true; summary: RunSummary } | { ok: false; error: WeatherErrorCode }

// 手动刷新：仅管理员可触发，跑一遍全量管道后返回运行摘要
export async function refreshWeatherAction(): Promise<RefreshWeatherResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  // 未登录或非管理员一律拒绝，防绕过 UI 直调动作
  if (!user || !isAdminEmail(user.email))
    return { ok: false, error: "unauthorized" }

  try {
    const summary = await runWeatherPipeline("manual")
    return { ok: true, summary }
  } catch {
    return { ok: false, error: "generic" }
  }
}

// 回填近 days 天（含今天）：仅管理员可触发，跑一遍历史回填后返回运行摘要。
// days 做安全钳制防误传超大值导致逐日接口循环
export async function backfillWeatherAction(
  days: number = 7
): Promise<RefreshWeatherResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  // 未登录或非管理员一律拒绝，防绕过 UI 直调动作
  if (!user || !isAdminEmail(user.email))
    return { ok: false, error: "unauthorized" }

  // 钳制到 1~30 天：Open-Meteo past_days 上限 92、OWM 日汇总 1 次/天，30 天足够且防误传
  const safeDays = Math.min(Math.max(Math.round(days) || 7, 1), 30)
  try {
    const summary = await runWeatherBackfill(safeDays)
    return { ok: true, summary }
  } catch {
    return { ok: false, error: "generic" }
  }
}
