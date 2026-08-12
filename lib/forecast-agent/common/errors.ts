// ForecastAgent 错误码：外部契约（API 返回 / 落库 error_code）一致。
// 单独成模块，供编排（core）与前端（hook/视图）共享，避免 UI 反向依赖编排模块
export type ForecastAgentErrorCode =
  | "no-model" // 未配置 AI 模型（actions 前置校验）
  | "retry-cooldown" // 失败后冷却期内禁止重试（5 分钟）
  | "insufficient-data" // 当日数据源不足（<2 源）
  | "provider" // AI 接口调用失败（网络/http/blocked）
  | "parse" // AI 返回无法解析为合法 JSON
  | "consistency" // AI 解读未过一致性闸门
  | "react-loop" // ReAct 循环步数耗尽未给出终态答案
  | "generic" // 兜底

// 已知错误码集合 + 判定：UI 取 i18n 文案前过滤非法码（防御外部 error_code 漂移落到缺失键）
export const FORECAST_ERROR_CODES = new Set<ForecastAgentErrorCode>([
  "no-model",
  "retry-cooldown",
  "insufficient-data",
  "provider",
  "parse",
  "consistency",
  "react-loop",
  "generic",
])

export function isForecastErrorCode(
  code: string | null | undefined
): code is ForecastAgentErrorCode {
  return (
    typeof code === "string" &&
    FORECAST_ERROR_CODES.has(code as ForecastAgentErrorCode)
  )
}
