import type { SpecialistAgent, SupervisorConfig } from "@/lib/agent-core/orchestrator"

import {
  buildReconcileMessages,
  buildRiskMessages,
  buildSupervisorMessages,
  type ForecastAgentCtx,
} from "./prompt"
import { buildTools } from "./tools"

// 预报生成的专家团注册：把编排层的通用「主管+专家」组装成预报领域的三个 agent。
// 编排层只负责执行与事件路由，这里提供各 agent 的提示词/工具/委托描述。
// 工具描述随 locale（en 模式必须英文，否则模型被中文工具文档带偏输出中文）。
// 类型里不放 label 字段——前端用固定 id→i18n 映射渲染时间线组名，未知 id 回落 raw

export const SUPERVISOR_AGENT_ID = "supervisor"
export const RECONCILE_AGENT_ID = "reconcile"
export const RISK_AGENT_ID = "risk"

// 源核对专家：带 query_source 工具，只读逐源核对分歧（maxSteps 给 3，分歧源可逐个查询）
export function buildReconcileSpecialist(
  ctx: ForecastAgentCtx
): SpecialistAgent<ForecastAgentCtx> {
  const delegateLabel =
    ctx.locale === "en"
      ? `Delegate to the source cross-check specialist to verify any source disagreements before finalizing.`
      : `委托给源核对专家：定稿前核对各源分歧。`
  return {
    agentId: RECONCILE_AGENT_ID,
    toolDescription: () => delegateLabel,
    buildMessages: () => buildReconcileMessages(ctx),
    buildTools: () => buildTools({ result: ctx.result, locale: ctx.locale }),
    maxSteps: 3,
  }
}

// 风险解读专家：无工具，只依据指标表 risk_flags 解读（一步直出即可）
export function buildRiskSpecialist(
  ctx: ForecastAgentCtx
): SpecialistAgent<ForecastAgentCtx> {
  const delegateLabel =
    ctx.locale === "en"
      ? `Delegate to the risk review specialist to interpret the platform's risk flags before finalizing.`
      : `委托给风险解读专家：解读平台标注的风险标记。`
  return {
    agentId: RISK_AGENT_ID,
    toolDescription: () => delegateLabel,
    buildMessages: () => buildRiskMessages(ctx),
    buildTools: () => [],
    maxSteps: 1,
  }
}

// 统筹主管：工具列表 = 编排层构造的 delegate 工具（先核对再风险，委托顺序固定）
export function buildSupervisorConfig(
  ctx: ForecastAgentCtx
): SupervisorConfig<ForecastAgentCtx> {
  return {
    agentId: SUPERVISOR_AGENT_ID,
    buildMessages: () => buildSupervisorMessages(ctx),
    buildTools: (_ctx, delegateTools) => delegateTools,
    maxSteps: 4,
  }
}
