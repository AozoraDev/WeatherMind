import { createServiceClient } from "@/supabase/service"
import {
  chatRequestBodySchema,
  conversationMessagesSchema,
  type ConversationMessage,
} from "@/lib/schemas/ai-agent"
import { runReActLoopStream } from "@/lib/agent-core/react-stream"
import { toLocalDateKey } from "@/lib/weather/daily"
import { buildMainAgentMessages } from "@/lib/ai-agent/agent/prompt"
import { buildMainAgentTools } from "@/lib/ai-agent/agent/tools"
import {
  createSseResponse,
  readJsonBody,
  requireUser,
} from "@/lib/ai-agent/common/route-helpers"
import {
  createForecastCardAccumulator,
  reduceToolEvent,
  toForecastCardInput,
} from "@/lib/ai-agent/a2ui/capture"
import { buildForecastCardMessages } from "@/lib/ai-agent/a2ui/forecast-card"
import type { A2uiMessage } from "@/lib/schemas/a2ui"

// AI 助手主 Agent 的流式端点：POST → SSE（text/event-stream）。
// 鉴权闭环同 forecast：/api 不走 supabase/proxy.ts 中间件，走公共 requireUser。
// 服务端以库内 messages 为权威历史（客户端只提交新的一条用户消息），归属校验走认证 client
// 的 RLS（查不到 = 非本人/不存在 → 404）。用户消息在调 provider 之前经原子追加 RPC 落库
// （流失败也不丢，多标签页并发不互相覆盖）；assistant 回复在 result 分支先落库再发 done，
// 保证 done 到达时客户端刷新即可读到全量回复。请求转发 request.signal：客户端断开即中断
// 在途 LLM 调用（省 token；断线放弃的回复不落库，用户消息已存），子 Agent 认领行的清理
// 由其自身 finally 负责。
//
// 主 Agent：ReAct 循环 + 数据工具。模型先用 query_city 定位城市、query_forecast 查今日
// 预报数据；无数据时经 generate_forecast 委托 forecast-agent 子 Agent 全流程生成并落库，
// 主 Agent 依据工具观察组织最终回答。工具过程对用户不可见（只显示最终回答）：
// delta 透传（含工具步思考文字，随后的 rollback 让客户端回滚），thought/tool 事件消费不转发。
//
// Next 16 注意：POST + cookies 自动动态，无需 export const dynamic；不设 runtime=edge
// （chatCompletionStream 内部 node:dns 需 Node runtime，默认即 Node）；流用手动 ReadableStream
// start 模式而非 ReadableStream.from（lib.dom 未声明该 API，strict 下类型报错）——见 createSseResponse

// 今日参考日期：平台城市均在日本时区，取 JST 日期作系统提示词的「今日」锚点；
// 各城真正的城市本地日由 query_forecast/generate_forecast 服务端按城市时区计算
const PLATFORM_TZ = "Asia/Tokyo"

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser()
  if (!auth.ok) return auth.response
  const userId = auth.user.id
  const session = auth.session

  // 请求体来自客户端 localStorage 的模型配置 + 输入，属不可信输入，整体过一遍 schema
  const parsedBody = await readJsonBody(request)
  if (!parsedBody.ok) return parsedBody.response
  const parsed = chatRequestBodySchema.safeParse(parsedBody.body)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "no-model" }), { status: 400 })
  }
  const { conversationId, content, locale, model } = parsed.data

  // 归属校验：认证 client 走 RLS 只放行本人行，查不到 → 404（不暴露存在性）。
  // 历史消息不再在此读——写入改走 append_conversation_message RPC，返回追加后的权威
  // messages（含并发标签页的消息），避免「读旧 messages → 拼新 → 整段写回」互相覆盖丢消息
  const convoRes = await session
    .from("ai_conversations")
    .select("id")
    .eq("id", conversationId)
    .single()
  if (convoRes.error || !convoRes.data) {
    return new Response(JSON.stringify({ error: "conversation-not-found" }), {
      status: 404,
    })
  }

  const service = createServiceClient()
  const now = new Date().toISOString()
  const userMsg: ConversationMessage = {
    role: "user",
    content,
    created_at: now,
  }
  // 首条用户消息：截断作对话标题（供侧栏展示），后续不再覆盖。
  // 按码点截断（slice 按 UTF-16 单元，会从 emoji 代理对中间切断产生孤代理项）
  const MAX_TITLE_LEN = 30
  const titleChars = Array.from(content)
  const title =
    titleChars.length > MAX_TITLE_LEN
      ? `${titleChars.slice(0, MAX_TITLE_LEN).join("")}…`
      : content

  // 原子追加用户消息（含首消息标题）：DB 内单条 UPDATE 做 messages || jsonb_build_array，
  // 行锁防并发覆盖；返回追加后的权威 messages 供构建提示词。data 为 null = 行不存在/非本人 → 404
  const appended = await service.rpc("append_conversation_message", {
    p_conversation_id: conversationId,
    p_user_id: userId,
    p_message: userMsg,
    p_title: title,
  })
  if (appended.error) {
    return new Response(JSON.stringify({ error: "generic" }), { status: 500 })
  }
  if (appended.data == null) {
    return new Response(JSON.stringify({ error: "conversation-not-found" }), {
      status: 404,
    })
  }
  // 自身写入的数据，防御性校验：结构异常视为服务端故障
  const messagesParsed = conversationMessagesSchema.safeParse(appended.data)
  if (!messagesParsed.success) {
    return new Response(JSON.stringify({ error: "generic" }), { status: 500 })
  }
  const stored = messagesParsed.data

  const today = toLocalDateKey(new Date().toISOString(), PLATFORM_TZ)

  return createSseResponse(async (send) => {
    // 流式期累积 a2ui 卡片消息串：result 分支先随 assistant 消息落库、再于 done 前下发
    let assistantA2ui: A2uiMessage[] | null = null
    // 流式期累积工具观察（城市名 + 预报指标），供 a2ui 卡片模板化使用
    const cardAcc = createForecastCardAccumulator()
    try {
      // 主 Agent ReAct 循环：工具步在内部执行（子 Agent 委托可能在工具步耗时数十秒），
      // 最终步逐 delta 产出回答全文。maxSteps 放宽到 6（定位城市→查数据→委托生成→作答），
      // 单步超时 5 分钟（与旧直出口径一致）
      const loop = runReActLoopStream({
        model: {
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
        },
        messages: buildMainAgentMessages(stored, locale, today),
        tools: buildMainAgentTools({
          session,
          service,
          email: auth.user.email ?? null,
          model,
          locale,
          // 主 Agent 与子 Agent（generate_forecast 委托）都在客户端断开时中断，不烧配额
          signal: request.signal,
        }),
        // 客户端断开即中止在途 LLM 调用（信号由 fetch 层合并超时），省 token
        signal: request.signal,
        timeoutMs: 300_000,
        maxSteps: 6,
      })
      for await (const ev of loop) {
        if (ev.type === "delta") {
          // 客户端断开时 enqueue 抛错：request.signal 随之中止，生成器在下一轮调用
          // 被中断自行收敛（省 token）。这里吞掉继续消费，不阻塞清理
          try {
            send({ type: "delta", text: ev.text })
          } catch {
            // 客户端已断开：忽略，交由信号驱动的中断接管
          }
        } else if (ev.type === "rollback") {
          // 工具步思考文字已按 delta 透传，通知客户端回滚（不属于最终回答正文）
          try {
            send({ type: "rollback", chars: ev.chars })
          } catch {
            // 客户端已断开：忽略
          }
        } else if (ev.type === "tool") {
          // 收集工具观察供卡片用（query_city 记城市名、预报工具记权威指标）；工具过程静默，不转发
          reduceToolEvent(cardAcc, ev, locale)
        } else if (ev.type === "result") {
          if (ev.result.ok) {
            // 拿到成功预报观察 → 服务端模板化 a2ui 卡片；构建失败只降级为纯 markdown，不阻塞回复
            const cardInput = toForecastCardInput(cardAcc)
            if (cardInput) {
              try {
                assistantA2ui = buildForecastCardMessages(cardInput, locale)
              } catch {
                // 卡片构建异常：降级纯 markdown
              }
            }
            // 先落库再发 done：done 到达时客户端刷新即可读到全量回复（防「done 先发、
            // 落库在 finally」的时序竞态）。usage/a2ui 为 null 时不写字段，保持库内数据干净
            const doneAt = new Date().toISOString()
            const persist = await service.rpc("append_conversation_message", {
              p_conversation_id: conversationId,
              p_user_id: userId,
              p_message: {
                role: "assistant",
                content: ev.result.content,
                created_at: doneAt,
                usage: ev.result.usage ?? undefined,
                a2ui: assistantA2ui ?? undefined,
              },
            })
            if (persist.error || persist.data == null) {
              // 落库失败不能宣称成功 → 带内 error（回复未持久化，客户端可重试）
              try {
                send({ type: "error", code: "generic" })
              } catch {
                // 客户端已断开：静默结束
              }
              return
            }
            try {
              if (assistantA2ui) send({ type: "a2ui", messages: assistantA2ui })
              send({
                type: "done",
                content: ev.result.content,
                usage: ev.result.usage,
              })
            } catch {
              // 客户端已断开：忽略（回复已落库，刷新可见）
            }
          } else {
            // 循环步数耗尽（react-loop）对用户归 generic，其余 provider 错误码直传
            const code =
              ev.result.error === "react-loop" ? "generic" : ev.result.error
            try {
              send({ type: "error", code })
            } catch {
              // 客户端已断开：忽略
            }
          }
        }
        // thought：只显示最终回答，工具过程静默，不转发
      }
    } catch {
      // 生成器未预期异常：带内 error 兜底；客户端已断开时 enqueue 抛错需再兜
      try {
        send({ type: "error", code: "generic" })
      } catch {
        // 客户端已断开：静默结束
      }
    }
    // 不再有 finally 落库：assistant 回复已在 result 分支先落库再发 done
  })
}
