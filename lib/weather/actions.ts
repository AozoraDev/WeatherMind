"use server"

import { createClient } from "@/lib/supabase/server"

import { isAdminEmail } from "./admin"
import { runWeatherPipeline, type RunSummary } from "./pipeline"
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
