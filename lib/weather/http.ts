// 统一网络封装：全项目天气请求只走这一个入口（满足 rules/fetch-usage.md 单封装约定）。
// 只负责「请求 + 取 JSON + 错误兜底」，schema 校验交给各适配器（见 providers/*）

export type HttpErrorCode = "network" | "http"

export type FetchJsonResult =
  { ok: true; json: unknown } | { ok: false; error: HttpErrorCode }

// 拉取并解析 JSON：网络异常归 network，非 2xx 归 http，绝不抛错
export async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<FetchJsonResult> {
  try {
    const res = await fetch(url, {
      ...init,
      // 天气数据要最新，禁用 Next 上游缓存，避免返回旧值
      cache: "no-store",
      headers: { accept: "application/json", ...init?.headers },
    })
    if (!res.ok) return { ok: false, error: "http" }
    return { ok: true, json: await res.json() }
  } catch {
    return { ok: false, error: "network" }
  }
}
