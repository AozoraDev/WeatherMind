// SSE 帧解析纯函数：provider（解析上游 OpenAI 流）与前端 hook（解析本项目 SSE 包）共用。
// 只做「按 \n\n 切块 + 剥 data: 壳 + 判 [DONE]」，不涉 JSON.parse（解析交给调用方按各自 schema 兜底）。
// 纯函数、无副作用，便于单测与 stryker 定向变异。

// 把字节缓冲按 \n\n 拆成完整事件块；末尾未以 \n\n 收尾的部分原样返回，由调用方保留继续累积。
// 容错：接受 \r\n 行尾（window.fetch 读回的文本可能带 \r），先规整 \r\n → \n
export function splitSseEvents(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const idx = normalized.lastIndexOf("\n\n")
  if (idx === -1) return { blocks: [], rest: normalized }
  const complete = normalized.slice(0, idx)
  const rest = normalized.slice(idx + 2)
  const blocks = complete.split("\n\n").filter((b) => b.length > 0)
  return { blocks, rest }
}

// 取事件块内所有 `data:` 行的 payload：剥掉 "data:" 前缀并 trim。
// 支持一个事件块内多行 data（SSE 规范：多行 data 拼成一条消息，中间以 \n 连接）
export function extractDataPayloads(block: string): string[] {
  const payloads: string[] = []
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      payloads.push(line.slice("data:".length).trim())
    } else if (line.startsWith(":")) {
      // 注释行（以 : 开头）忽略
    }
  }
  return payloads
}

// 判断 payload 是否为流结束哨兵（OpenAI 兼容接口用 data: [DONE] 收尾）
export function isDonePayload(payload: string): boolean {
  return payload.trim() === "[DONE]"
}
