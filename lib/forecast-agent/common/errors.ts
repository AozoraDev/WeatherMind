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
