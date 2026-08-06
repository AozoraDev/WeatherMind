import { runWeatherPipeline } from "@/lib/weather/pipeline"

// 外部定时任务入口（Vercel Cron 等）：用 x-weather-cron-secret 头自鉴权后跑管道。
// /api 不在 proxy.ts 中间件匹配范围内（无用户会话），必须自鉴权
export async function GET(request: Request) {
  const secret = request.headers.get("x-weather-cron-secret")
  // 未配置 WEATHER_CRON_SECRET 时恒 401（安全默认）
  if (
    !process.env.WEATHER_CRON_SECRET ||
    secret !== process.env.WEATHER_CRON_SECRET
  ) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const summary = await runWeatherPipeline("cron")
  // 状态码恒 200（成功/部分失败都算「已执行」），成功程度由 status 字段表达，cron 无需按 5xx 告警
  return Response.json(summary)
}
