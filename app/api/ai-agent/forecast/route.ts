import { createClient } from "@/supabase/server"
import { createServiceClient } from "@/supabase/service"
import { modelConfigSchema } from "@/lib/schemas/ai"
import {
  runForecastAgentStream,
  type ForecastAgentStreamEvent,
} from "@/lib/forecast-agent/stream/stream"

// 预报页「预报当日」的流式端点：POST → SSE（text/event-stream）。
// 鉴权闭环：/api 不走 supabase/proxy.ts 中间件（见 CLAUDE.md），这里自行 createClient + getUser，
// 与既有 Server Action 同一套已验证模式。前置校验（未登录/非法参数）在流开始前用非 2xx JSON 返回；
// 流开始后一切错误走带内 error 事件（流已发出，不能再改状态码/头）。
//
// Next 16 注意：POST + cookies 自动动态，无需 export const dynamic；不设 runtime=edge
// （node:dns 需 Node runtime，默认即 Node）；流用手动 ReadableStream start 模式而非
// ReadableStream.from（lib.dom 未声明该 API，strict 下类型报错）
export async function POST(request: Request): Promise<Response> {
  const session = await createClient()
  const {
    data: { user },
  } = await session.auth.getUser()
  const email = user?.email
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
    })
  }

  // 模型配置来自客户端 localStorage，属不可信输入，服务端重新过一遍 schema
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: "no-model" }), { status: 400 })
  }
  const { cityId, locale, model } = body as {
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
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: ForecastAgentStreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
      }
      try {
        for await (const ev of runForecastAgentStream(session, service, {
          cityId,
          email,
          locale,
          model: parsed.data,
          // 转发客户端断开信号：断线时生成器尽早停止，并由其 finally 清理 pending 行
          signal: request.signal,
        })) {
          send(ev)
        }
      } catch {
        // 生成器未预期异常：带内 error 兜底；客户端已断开时 enqueue 可能抛错，需再兜
        try {
          send({ type: "error", code: "generic" })
        } catch {
          // 客户端已断开：静默结束
        }
      } finally {
        try {
          controller.close()
        } catch {
          // 流已关闭/断开则忽略
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
