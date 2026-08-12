import type { User } from "@supabase/supabase-js"

import { createClient } from "@/supabase/server"

// /api/ai-agent/* 流式路由共用工具：鉴权、JSON body 解析、SSE 响应构造。
// /api 不走 supabase/proxy.ts 中间件（见 CLAUDE.md），各路由自行 createClient + getUser，
// 这里把三段样板收敛成公共 helper，口径统一（401/400 文案、SSE 头、断流兜底）。

export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
}

type SessionClient = Awaited<ReturnType<typeof createClient>>

export type RequireUserResult =
  | { ok: true; user: User; session: SessionClient }
  | { ok: false; response: Response }

// 自鉴权：createClient + getUser；未登录返回 401。session 一并返回，调用方做 RLS 查询/传参
export async function requireUser(): Promise<RequireUserResult> {
  const session = await createClient()
  const {
    data: { user },
  } = await session.auth.getUser()
  if (!user) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      }),
    }
  }
  return { ok: true, user, session }
}

export type ReadJsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: Response }

// request.json() 解析失败按「模型配置缺失」口径 400（沿用 forecast/chat 现状）
export async function readJsonBody(
  request: Request
): Promise<ReadJsonBodyResult> {
  try {
    return { ok: true, body: await request.json() }
  } catch {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "no-model" }), {
        status: 400,
      }),
    }
  }
}

// SSE 响应构造：手动 ReadableStream start 模式（Next 16 strict 下 ReadableStream.from
// 无 lib.dom 声明），逐事件编码 `data: {...}\n\n`；run 内 send 抛错（客户端断开）由调用方
// 自行处理（如继续消费生成器），外层 catch 兜底带内 generic + finally close。
export function createSseResponse(
  run: (send: <T>(ev: T) => void) => Promise<void>
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = <T>(ev: T) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
      }
      try {
        await run(send)
      } catch {
        // 生成器未预期异常：带内 error 兜底；客户端已断开时 enqueue 抛错需再兜
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
  return new Response(stream, { headers: SSE_RESPONSE_HEADERS })
}
