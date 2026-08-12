import { createServiceClient } from "@/supabase/service"
import { modelConfigSchema } from "@/lib/schemas/ai"
import { runForecastAgentStream } from "@/lib/forecast-agent/stream/stream"
import {
  createSseResponse,
  readJsonBody,
  requireUser,
} from "@/lib/ai-agent/common/route-helpers"

// 预报页「预报当日」的流式端点：POST → SSE（text/event-stream）。
// 鉴权闭环：/api 不走 supabase/proxy.ts 中间件（见 CLAUDE.md），这里走公共 requireUser
// （createClient + getUser）。前置校验（未登录/非法参数）在流开始前用非 2xx JSON 返回；
// 流开始后一切错误走带内 error 事件（流已发出，不能再改状态码/头）。
//
// Next 16 注意：POST + cookies 自动动态，无需 export const dynamic；不设 runtime=edge
// （node:dns 需 Node runtime，默认即 Node）；流用手动 ReadableStream start 模式而非
// ReadableStream.from（lib.dom 未声明该 API，strict 下类型报错）——见 createSseResponse
export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const email = auth.user.email
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
    })
  }

  // 模型配置来自客户端 localStorage，属不可信输入，服务端重新过一遍 schema
  const parsedBody = await readJsonBody(request)
  if (!parsedBody.ok) return parsedBody.response
  const { cityId, locale, model } = parsedBody.body as {
    cityId?: unknown
    locale?: unknown
    model?: unknown
  }
  if (typeof cityId !== "string" || (locale !== "zh" && locale !== "en")) {
    return new Response(JSON.stringify({ error: "no-model" }), { status: 400 })
  }
  const parsed = modelConfigSchema.safeParse(model)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "no-model" }), { status: 400 })
  }

  const service = createServiceClient()

  return createSseResponse(async (send) => {
    for await (const ev of runForecastAgentStream(auth.session, service, {
      cityId,
      email,
      locale,
      model: parsed.data,
      // 转发客户端断开信号：断线时生成器尽早停止，并由其 finally 清理 pending 行
      signal: request.signal,
    })) {
      send(ev)
    }
  })
}
