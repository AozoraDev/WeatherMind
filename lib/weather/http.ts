// 统一网络封装：全项目天气请求只走这一个入口（满足 rules/fetch-usage.md 单封装约定）。
// 只负责「请求 + 取 JSON + 错误兜底」，schema 校验交给各适配器（见 providers/*）

export type HttpErrorCode = "network" | "http"

export type FetchJsonResult =
  { ok: true; json: unknown } | { ok: false; error: HttpErrorCode }

// 外部取消信号（客户端断线等，经 init.signal 传入）与 timeoutMs 超时信号合并：
// 任一触发即取消（Node 20.3+/jsdom 23+ 均支持 AbortSignal.any）。
// 只有单信号时原样返回，都不传则 undefined，保持原行为不变
function combineSignal(
  external: AbortSignal | null | undefined,
  timeoutMs: number | undefined
): AbortSignal | undefined {
  const signals = [
    external,
    timeoutMs ? AbortSignal.timeout(timeoutMs) : null,
  ].filter((s): s is AbortSignal => s != null)
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

// 拉取并解析 JSON：网络异常归 network，非 2xx 归 http，绝不抛错。
// timeoutMs 传入时用 AbortSignal.timeout 限时（AI 模型调用等慢接口用），超时归 network
export async function fetchJson(
  url: string,
  init?: RequestInit,
  timeoutMs?: number
): Promise<FetchJsonResult> {
  try {
    const res = await fetch(url, {
      ...init,
      // 天气数据要最新，禁用 Next 上游缓存，避免返回旧值
      cache: "no-store",
      headers: { accept: "application/json", ...init?.headers },
      signal: combineSignal(init?.signal, timeoutMs),
    })
    if (!res.ok) return { ok: false, error: "http" }
    return { ok: true, json: await res.json() }
  } catch {
    return { ok: false, error: "network" }
  }
}

export type FetchStreamResult =
  | { ok: true; response: Response } // 已通过 res.ok，body 由调用方逐块读取
  | { ok: false; error: HttpErrorCode } // "network" | "http"

// 流式 fetch：与 fetchJson 同构（禁用缓存、限时、错误兜底），但**不读 body**——
// 流式响应需调用方用 response.body.getReader() 逐块消费（AI 流式/SSE 场景）。
// body 缺失（响应无实体）也归 network，与「读不到数据」语义一致
export async function fetchStream(
  url: string,
  init?: RequestInit,
  timeoutMs?: number
): Promise<FetchStreamResult> {
  try {
    const res = await fetch(url, {
      ...init,
      // SSRF 防护：禁止跟随重定向。流式调用只对初始 URL 做过前置校验（agent 的
      // assertPublicBaseUrl），3xx 跳转目标不再复查——跟随会把用户可控 baseUrl 的
      // 跳转导向内网。manual 下 3xx 原样返回（res.ok=false），归 http 错误不追踪
      redirect: "manual",
      cache: "no-store",
      headers: { accept: "text/event-stream", ...init?.headers },
      signal: combineSignal(init?.signal, timeoutMs),
    })
    if (!res.ok) return { ok: false, error: "http" }
    if (!res.body) return { ok: false, error: "network" }
    return { ok: true, response: res }
  } catch {
    return { ok: false, error: "network" }
  }
}
