import { METRICS } from "@/lib/schemas/forecast-agent"
import type { ChatMessage } from "@/lib/agent-core/chat"
import type { PredictionResult, RiskFlag } from "@/lib/schemas/forecast-agent"
import { sourceSchema } from "@/lib/schemas/weather"
import { detectSourceDivergences, type SourceDivergence } from "../engine/divergence"
import { TEXTS, type LocaleText, type AgentRoleText } from "./prompt-text"

// ForecastAgent 的 AI 提示词：分层架构（见 .claude/skills/prompt）。
// 多 agent 编排后，提示词按 agent 拆成三个构建函数（supervisor/reconcile/risk），
// 各自 system 五层：角色 → 背景 → 任务 → 约束 → 输出；user 两层：数据（城市/日期/指标表/权重/源/分歧）+ 输出。
// 背景层只给「确定性内核算出的指标」，各源原始快照不内联——要看某源原始预报必须调 query_source
// （见任务层 ReAct 协议），工具因此成为承重墙。源间有分歧时注入强制核对指令（divergenceBlock），
// 驱动 reconcile 专家实际调用工具。关键：整份上下文（指标表 label/note、风险行、分隔符、分歧块）都按语言输出，
// 否则英文模式下模型看到中文数据表会顺着输出中文（summary/points 语言跑偏）。

// 各 agent 共享的上下文形状：city/日期/确定性结果/语言。specialists.ts 用它组装专家团注册
export type ForecastAgentCtx = {
  city: { nameJa: string; nameEn: string }
  day: string
  result: PredictionResult
  locale: "zh" | "en"
}


// 可查询源列表（单一来源：query_source 工具 enum 即 sourceSchema.options，
// 提示词广告的源必须与工具接受范围严格一致，防模型按提示词调出非法源）
const QUERYABLE_SOURCES = sourceSchema.options

// {key} 占位符替换；未知占位符原样保留
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`)
}

// 风险行文案：按语言模板渲染（等级/源数措辞随语言）
function riskLines(t: LocaleText, flags: RiskFlag[]): string {
  if (flags.length === 0) return t.riskNone
  return flags
    .map((flag) =>
      fill(t.riskLine, {
        label: t.risk[flag.type] ?? flag.type,
        level: t.riskLevel[flag.level] ?? flag.level,
        n: String(flag.sources),
      })
    )
    .join("\n")
}

// 模板指标 id 顺序（唯一来源）：buildContext 与 formatMetricValue 共用，防漂移
export const METRIC_ROW_IDS = [
  METRICS.high,
  METRICS.low,
  METRICS.highInterval,
  METRICS.lowInterval,
  METRICS.poP,
  METRICS.precipLevel,
  METRICS.condition,
  METRICS.wind,
  METRICS.humidity,
  METRICS.confidence,
  METRICS.risk,
] as const

// 指标值唯一格式化来源：buildContext 指标表与 get_metric 工具共用，
// 保证模型在提示词与工具观察里看到同一份权威表示，杜绝两处口径漂移
export function formatMetricValue(
  locale: "zh" | "en",
  result: PredictionResult,
  metricId: string
): string {
  const t = TEXTS[locale]
  switch (metricId) {
    case METRICS.high:
      return `${result.high}°C`
    case METRICS.low:
      return `${result.low}°C`
    case METRICS.highInterval:
      return `${result.highInterval[0]}~${result.highInterval[1]}°C`
    case METRICS.lowInterval:
      return `${result.lowInterval[0]}~${result.lowInterval[1]}°C`
    case METRICS.poP:
      return `${result.poP}%`
    case METRICS.precipLevel:
      return t.precipLevel[result.precipLevel] ?? result.precipLevel
    case METRICS.condition:
      return t.condition[result.condition] ?? result.condition
    case METRICS.wind:
      return fill(t.windValue, { n: String(result.windBeaufort) })
    case METRICS.humidity:
      return `${result.humidity}%`
    case METRICS.confidence:
      return t.confidence[result.confidence] ?? result.confidence
    case METRICS.risk:
      return riskLines(t, result.riskFlags)
    default:
      return ""
  }
}

// 指标表 + 权重行：全部用当前语言的 label/note/模板组装（源快照不在此内联）。
// 导出供各 agent 的 user 数据段复用（单一权威表示）
export function buildContext(
  t: LocaleText,
  locale: "zh" | "en",
  result: PredictionResult
): { metricTable: string; weightsLine: string } {
  const metricTable = METRIC_ROW_IDS.map((id) =>
    fill(t.metricLine, {
      id,
      label: t.metric[id]?.label ?? id,
      value: formatMetricValue(locale, result, id),
      note: t.metric[id]?.note ?? "",
    })
  ).join("\n")

  // 只列数值型源权重：result.weights 若带 detail 明细字段，Object.entries 会泄漏 [object Object]
  const weightsLine = Object.entries(result.weights)
    .filter(([, w]) => typeof w === "number")
    .map(([s, w]) => `${s}=${w}`)
    .join(t.weightsSep)

  return { metricTable, weightsLine }
}

// 单条分歧的本地化描述：按 kind 渲染对应模板
function renderDivergence(t: LocaleText, d: SourceDivergence): string {
  switch (d.kind) {
    case "precip":
      return fill(t.divergencePrecip, {
        wet: d.wet.join(t.weightsSep),
        dry: d.dry.join(t.weightsSep),
      })
    case "condition":
      return fill(t.divergenceCondition, {
        groups: d.groups
          .map((g) =>
            fill(t.divergenceConditionGroup, {
              cond: t.condition[g.condition] ?? g.condition,
              sources: g.sources.join(t.weightsSep),
            })
          )
          .join(t.weightsSep),
      })
    case "temperature":
      return fill(t.divergenceTemperature, {
        metric:
          t.metric[d.metric === "high" ? METRICS.high : METRICS.low]?.label ??
          d.metric,
        spread: String(d.spread),
        min: String(d.min),
        max: String(d.max),
      })
  }
}

// 分歧块：无分歧返回空串（reconcile 专家仍会在任务里说明无需核对）；
// 有分歧给「逐源核对 + 不得仅凭聚合指标作答」的强制指令，驱动 reconcile 真实调用工具。
// 导出供 reconcile/supervisor 的 user 数据段复用
export function divergenceBlock(t: LocaleText, result: PredictionResult): string {
  const divergences = detectSourceDivergences(result.sourceInputs)
  if (divergences.length === 0) return ""
  const list = divergences
    .map((d) => renderDivergence(t, d))
    .join(t.weightsSep)
  return `${fill(t.divergenceLead, { list })}\n${t.divergenceVerify}`
}

// 单个 agent 的 system 消息：按语言组装的五层结构
function buildSystem(locale: "zh" | "en", r: AgentRoleText): string {
  if (locale === "en")
    return `[Role] ${r.role}\n\n[Context] ${r.background}\n\n[Task] ${r.task}\n\n[Constraints]\n${r.constraints}\n\n[Output] ${r.output}`
  return `【角色】${r.role}\n\n【背景】${r.background}\n\n【任务】${r.task}\n\n【约束】\n${r.constraints}\n\n【输出】${r.output}`
}

// 用户数据段（各 agent 共享底座）：城市/日期 + 指标表，按需追加权重行/可查源/分歧块。
// 标签随语言（en 数据表必须英文，否则模型顺着输出中文）；指标 id 不变。
// 无工具 agent（risk）只给指标表；有工具 agent（reconcile）再给源列表与分歧块
type UserDataOpts = {
  weights?: boolean // 权重行（仅主管需要：定稿依据）
  sources?: boolean // 可查源列表（query_source 工具 enum 广告，须与工具接受范围一致）
  divergence?: boolean // 分歧块（reconcile/supervisor 需要，驱动核对）
}
function buildUserData(
  t: LocaleText,
  locale: "zh" | "en",
  ctx: ForecastAgentCtx,
  opts: UserDataOpts = {}
): string {
  const { metricTable, weightsLine } = buildContext(t, locale, ctx.result)
  const city =
    locale === "en"
      ? `${ctx.city.nameEn} (${ctx.city.nameJa})`
      : `${ctx.city.nameJa}（${ctx.city.nameEn}）`
  const dataHead =
    locale === "en"
      ? `[Data] City: ${city}\nDay (local): ${ctx.day}\n\nPlatform metrics (authoritative):\n${metricTable}`
      : `【数据】城市：${city}\n日期（城市本地日）：${ctx.day}\n\n平台计算出的指标（权威数据）：\n${metricTable}`
  const sections: string[] = [dataHead]
  if (opts.weights) sections.push(fill(t.weightsNote, { weights: weightsLine }))
  if (opts.sources)
    sections.push(
      locale === "en"
        ? `Available sources for query_source: ${QUERYABLE_SOURCES.join(t.weightsSep)}.`
        : `可查询的源（query_source）：${QUERYABLE_SOURCES.join(t.weightsSep)}。`
    )
  if (opts.divergence) {
    const block = divergenceBlock(t, ctx.result)
    if (block) sections.push(block)
  }
  return sections.join("\n\n")
}

// —— 主管（输出 agent）：先委托两位专家再综合定稿 ——
// 为确定性「始终调用两位专家」：任务层硬性要求定稿前依次调用，否则无分歧时日间线可能只剩主管
export function buildSupervisorMessages(ctx: ForecastAgentCtx): ChatMessage[] {
  const t = TEXTS[ctx.locale]
  const system = buildSystem(ctx.locale, t.agentRoles.supervisor)
  const data = buildUserData(t, ctx.locale, ctx, {
    weights: true,
    sources: true,
    divergence: true,
  })
  const outputLabel = ctx.locale === "en" ? "[Output]" : "【输出】"
  const user = `${data}\n\n${outputLabel} ${t.supervisorUserOutput}`
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

// —— 源核对专家：只读逐源核对分歧 ——
export function buildReconcileMessages(ctx: ForecastAgentCtx): ChatMessage[] {
  const t = TEXTS[ctx.locale]
  const system = buildSystem(ctx.locale, t.agentRoles.reconcile)
  const user = buildUserData(t, ctx.locale, ctx, { sources: true, divergence: true })
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

// —— 风险解读专家：无工具，仅依据指标表解读 risk_flags ——
export function buildRiskMessages(ctx: ForecastAgentCtx): ChatMessage[] {
  const t = TEXTS[ctx.locale]
  const system = buildSystem(ctx.locale, t.agentRoles.risk)
  const user = buildUserData(t, ctx.locale, ctx, {})
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}
