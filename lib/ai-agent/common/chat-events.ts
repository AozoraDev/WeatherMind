import type { ChatUsage } from "@/lib/schemas/agent-core"
import type { ProviderErrorCode } from "@/lib/agent-core/chat"
import type { A2uiMessage } from "@/lib/schemas/a2ui"

// /api/ai-agent/chat 与前端 use-chat-stream 共用的事件契约（防两处漂移）：
// delta = content 增量；rollback = 把已按 delta 累积进回答的思考文字从尾部回滚
// （主 Agent ReAct 工具步的思考文字会经 delta 透传，不属于最终回答正文）；
// a2ui = 服务端模板化生成的 A2UI 卡片消息串（天气工具返回成功数据时在 done 之前下发，
// 客户端经 MessageProcessor 渲染原生卡片；构建失败则不下发，纯 markdown 降级）；
// done = 流结束（content 为 AI 全量回复，可能为空串；usage 为本次请求跨步累计的
// token 消耗，provider 缺省时为 null，前端据此显示气泡下页脚）；error = 带内错误码。
// error 码沿用 provider 错误码（invalid-url/blocked/network/http/parse），兜底 generic
export type ChatSseEvent =
  | { type: "delta"; text: string }
  | { type: "rollback"; chars: number }
  | { type: "a2ui"; messages: A2uiMessage[] }
  | { type: "done"; content: string | null; usage: ChatUsage | null }
  | { type: "error"; code: ProviderErrorCode | "generic" }
