import { METRICS } from "@/lib/schemas/forecast-agent"
import type { ConditionCategory } from "@/lib/schemas/weather"

// ForecastAgent 提示词的本地化文案表：zh/en 各一份，占位符统一 {key} 由 fill 替换。
// MetricMeta 也放这里（LocaleText.metric 的类型），prompt.ts 只做消息组装，不背文案数据

export type MetricMeta = { label: string; note: string }

// 单个 agent 的 system 五层文本（角色→背景→任务→约束→输出），按语言各一份
export type AgentRoleText = {
  role: string
  background: string
  task: string
  constraints: string // 多行含序号，整段插入「【约束】/约束」层
  output: string
}

export type LocaleText = {
  metricLine: string // {id} {label} {value} {note}
  windValue: string // {n} → 蒲福风级值文案
  weightsSep: string // 各源权重/列表分隔符
  riskLine: string // {label} {level} {n} → 风险行
  riskNone: string
  weightsNote: string // {weights}
  condition: Record<ConditionCategory, string> // 条件类别标签
  precipLevel: Record<string, string> // 降水等级标签（none/light/moderate/heavy）
  confidence: Record<string, string> // 可信度标签（high/medium/low）
  divergenceLead: string // {list} → 分歧块引言
  divergenceVerify: string // 强制核对指令
  divergencePrecip: string // {wet} {dry} → 降水分歧描述
  divergenceCondition: string // {groups} → 条件分歧描述
  divergenceConditionGroup: string // {cond} {sources} → 单组条件分歧
  divergenceTemperature: string // {metric} {spread} {min} {max} → 温差分歧描述
  metric: Record<string, MetricMeta>
  risk: Record<string, string>
  riskLevel: Record<string, string>
  // 多 agent 编排：主管/源核对/风险解读三位 agent 的 system 五层文本
  agentRoles: {
    supervisor: AgentRoleText
    reconcile: AgentRoleText
    risk: AgentRoleText
  }
  // 主管 user 消息尾部的输出指令（两段 Markdown 契约；reconcile/risk 无独立输出契约）
  supervisorUserOutput: string
}

export const TEXTS: Record<"zh" | "en", LocaleText> = {
  zh: {
    metricLine: "- {id}（{label}）：{value}　※{note}",
    windValue: "{n} 级",
    weightsSep: "，",
    riskLine: "- {label}（{level}）：{n} 个数据源一致",
    riskNone: "（无风险标记）",
    weightsNote: "各源权重（{weights}）：权重越高该源越可信。",
    condition: {
      clear: "晴",
      partlyCloudy: "多云间晴",
      cloudy: "阴",
      fog: "雾",
      rain: "雨",
      snow: "雪",
      storm: "雷暴",
      other: "其他",
    },
    precipLevel: { none: "无降水", light: "小雨", moderate: "中雨", heavy: "大雨" },
    confidence: { high: "高", medium: "中", low: "低" },
    divergenceLead: "检测到各源数据分歧：{list}。",
    divergenceVerify: "请先调用 query_source 逐一核对分歧源的原始快照后再定稿。",
    divergencePrecip: "降水 {wet} 报有雨、{dry} 报无雨",
    divergenceCondition: "天气状况 {groups}",
    divergenceConditionGroup: "{cond}：{sources}",
    divergenceTemperature: "{metric} 源间差距 {spread}°C（{min}~{max}°C）",
    metric: {
      [METRICS.high]: { label: "预测高温", note: "加权集成均值" },
      [METRICS.low]: { label: "预测低温", note: "加权集成均值" },
      [METRICS.highInterval]: {
        label: "高温区间",
        note: "均值 ± 1.28×加权标准差（约80%置信）",
      },
      [METRICS.lowInterval]: {
        label: "低温区间",
        note: "均值 ± 1.28×加权标准差（约80%置信）",
      },
      [METRICS.poP]: { label: "降水概率", note: "报雨源权重之和" },
      [METRICS.precipLevel]: {
        label: "降水等级",
        note: "按加权降水均值分级（无/小/中/大雨）",
      },
      [METRICS.condition]: { label: "天气状况", note: "加权多数投票" },
      [METRICS.wind]: { label: "风力", note: "加权风速换算蒲福风级" },
      [METRICS.humidity]: { label: "湿度", note: "加权平均" },
      [METRICS.confidence]: {
        label: "可信度",
        note: "源之间一致强度（不依赖历史真值）",
      },
      [METRICS.risk]: { label: "风险标记", note: "阈值 + 多源一致" },
    },
    risk: {
      heat: "高温",
      cold: "低温",
      heavyRain: "强降水",
      wind: "大风",
      storm: "雷暴",
      snow: "降雪",
      diurnal: "昼夜温差大",
    },
    riskLevel: { warning: "警告", info: "提醒" },
    agentRoles: {
      supervisor: {
        role:
          "你是天气预报撰写的统筹主管。职责：把平台确定性引擎算出的指标转成一份可读的预报文档——拆解任务、委托专家核对数据与解读风险、最后综合定稿。",
        background:
          "平台已用确定性引擎（多源加权集成）算出下方指标；各源原始快照不内联。你拥有两位专家的委托工具：delegate_reconcile（源核对专家，逐源核对分歧）、delegate_risk（风险解读专家，解读风险标记）。",
        task: "定稿前必须依次调用 delegate_reconcile 与 delegate_risk 两位专家（每次调用会执行专家的完整任务并返回其结论），再综合两位专家的结论与下方指标表撰写最终文档。",
        constraints: `1. 预报里所有数值必须来自下方指标表，绝不编造、改写或换口径。
2. 推理过程段须说明定稿依据，并引用两位专家的结论（源核对结论 / 风险解读结论）。
3. 专家报告风险时，预报必须提及；无风险不得虚构，不得使用「高风险/预警」措辞。
4. 不质疑、不贬低平台指标，只做解释与行动建议。
5. 预报正文（## 预报）用 2~3 句简洁叙述给出总览与行动建议，必须包含预测高温、低温与降水概率，但不逐条罗列指标表——数值以图标卡片单独展示。`,
        output:
          "最终消息只输出一份 Markdown 文档，仅含以下两个二级标题段落（顺序固定），除此之外不要任何内容（不要 JSON、不要代码围栏）：## 推理过程（简洁推理叙述）+ ## 预报（总览与行动建议）。所有文本必须使用简体中文，不得混入英文。",
      },
      reconcile: {
        role:
          "你是源核对专家。职责：只读各源的原始预报快照，核对源间分歧并给出结论。",
        background:
          "你有 query_source(source) 工具读取任一源的原始预报快照（高温/低温/降水/条件/湿度/风）。下方指标表是聚合结果，分歧块列出源间分歧。",
        task: "对分歧块列出的每个分歧源调用 query_source 读取原始快照；判断分歧是否真实、哪一方更可信，给出简洁核对结论。若没有分歧，直接说明无需核对。",
        constraints: `1. 只读快照：绝不推演、重算或修改任何聚合指标数值。
2. 每个分歧源至少查询一次，不得仅凭聚合指标作答。
3. 结论只描述快照事实与判断，不撰写最终预报正文。`,
        output:
          "用简体中文输出一段简洁的核对结论（供主管引用），不要 Markdown 标题。",
      },
      risk: {
        role:
          "你是风险解读专家。职责：解读平台标注的风险标记，给读者风险提示与行动建议。",
        background:
          "下方指标表的「风险标记」行列出风险（阈值 + 多源一致）。每行含：风险类型、等级（提醒/警告）、一致源数。",
        task: "逐条解读每条风险：说明风险内容、等级含义、对出行/活动的影响与建议；若没有风险标记，明确说明无风险即可。",
        constraints: `1. 只解读指标表里已有的风险，绝不虚构或夸大。
2. 无风险时不得使用「高风险/预警」等措辞。
3. 不重算数值、不引用其他指标行的具体数值。`,
        output:
          "用简体中文输出一段简洁的风险解读结论（供主管引用），不要 Markdown 标题。",
      },
    },
    supervisorUserOutput: `请输出一份 Markdown 文档，仅含以下两个二级标题段落（顺序固定），除此之外不要任何内容（不要 JSON、不要代码围栏）：
## 推理过程
简洁的推理叙述（简体中文，引用两位专家的结论）。
## 预报
用 2~3 句简洁叙述给出总览与行动建议，仍必须包含预测高温与低温（含 °C）、降水概率（%）等关键数值，并可提及天气状况、风力、湿度、可信度与风险标记（如有）；但不要逐条罗列上方指标表——数值会以图标卡片单独展示。所有数值必须来自上方指标表。`,
  },
  en: {
    metricLine: "- {id} ({label}): {value} ※{note}",
    windValue: "Bft {n}",
    weightsSep: ", ",
    riskLine: "- {label} ({level}): {n} source(s) agree",
    riskNone: "(no risk flags)",
    weightsNote:
      "Per-source weights ({weights}): higher weight means the source is more trusted.",
    condition: {
      clear: "Clear",
      partlyCloudy: "Partly cloudy",
      cloudy: "Cloudy",
      fog: "Fog",
      rain: "Rain",
      snow: "Snow",
      storm: "Storm",
      other: "Other",
    },
    precipLevel: {
      none: "No rain",
      light: "Light",
      moderate: "Moderate",
      heavy: "Heavy",
    },
    confidence: { high: "High", medium: "Medium", low: "Low" },
    divergenceLead: "The sources disagree: {list}.",
    divergenceVerify:
      "Call query_source to verify each diverging source's raw snapshot before finalizing.",
    divergencePrecip: "precipitation: {wet} report rain, {dry} report no rain",
    divergenceCondition: "condition: {groups}",
    divergenceConditionGroup: "{cond}: {sources}",
    divergenceTemperature:
      "{metric} spread {spread}°C across sources ({min}~{max}°C)",
    metric: {
      [METRICS.high]: {
        label: "Predicted high",
        note: "weighted ensemble mean",
      },
      [METRICS.low]: { label: "Predicted low", note: "weighted ensemble mean" },
      [METRICS.highInterval]: {
        label: "High range",
        note: "mean ± 1.28× weighted std (≈80% confidence)",
      },
      [METRICS.lowInterval]: {
        label: "Low range",
        note: "mean ± 1.28× weighted std (≈80% confidence)",
      },
      [METRICS.poP]: {
        label: "Precipitation probability",
        note: "sum of weights of rain-reporting sources",
      },
      [METRICS.precipLevel]: {
        label: "Precip level",
        note: "graded by weighted precip mean (none/light/moderate/heavy)",
      },
      [METRICS.condition]: {
        label: "Condition",
        note: "weighted majority vote",
      },
      [METRICS.wind]: {
        label: "Wind",
        note: "weighted wind speed → Beaufort scale",
      },
      [METRICS.humidity]: { label: "Humidity", note: "weighted average" },
      [METRICS.confidence]: {
        label: "Confidence",
        note: "inter-source agreement strength (no historical truth needed)",
      },
      [METRICS.risk]: {
        label: "Risk flags",
        note: "threshold + multi-source agreement",
      },
    },
    risk: {
      heat: "Heat",
      cold: "Cold",
      heavyRain: "Heavy rain",
      wind: "Wind",
      storm: "Storm",
      snow: "Snow",
      diurnal: "Large diurnal range",
    },
    riskLevel: { warning: "warning", info: "info" },
    agentRoles: {
      supervisor: {
        role:
          "You are the supervisor in charge of writing the weather forecast. Your job is to turn the deterministic metrics below into a readable forecast document: break the task down, delegate data verification and risk interpretation to specialists, then synthesize the final document.",
        background:
          "The platform computed the metrics below with a deterministic multi-source ensemble engine. Per-source raw snapshots are NOT inlined. You have two delegate tools: delegate_reconcile (source cross-check: verifies diverging sources) and delegate_risk (risk review: interprets risk flags).",
        task: "Before finalizing, you MUST call both delegate_reconcile and delegate_risk (each call runs the specialist's full task and returns its conclusion), then write the final document from the two conclusions and the metric table below.",
        constraints: `1. Every number in the forecast MUST come from the metric table below — never invent, round differently, or alter any value.
2. The reasoning section must state your basis and cite both specialists' conclusions (cross-check conclusion / risk review conclusion).
3. When a specialist reports risks, the forecast MUST mention them; if there are no risks, do not fabricate risks or use alarming words.
4. Never challenge or belittle the platform metrics; only explain and advise.
5. The forecast section (## Forecast) must be a concise narrative of 2-3 sentences (overview + action advice). It must still include the predicted high and low temperatures and the precipitation probability, but do not paste the metric table line by line — the numbers are shown as icon cards.`,
        output:
          "In your final message, output only ONE Markdown document with exactly these two H2 sections, in this order, and nothing else (no JSON, no code fences): ## Reasoning (concise reasoning narrative) + ## Forecast (overview + action advice). Write all text in English — never Chinese or Japanese.",
      },
      reconcile: {
        role:
          "You are the source cross-check specialist. Your job is to read each source's raw forecast snapshot and verify disagreements between sources.",
        background:
          "You have a query_source(source) tool that reads any source's raw forecast snapshot (high/low/precip/condition/humidity/wind). The metric table below is the aggregated result; the divergence block lists where sources disagree.",
        task: "Call query_source on every source listed in the divergence block to read its raw snapshot; judge whether the divergence is real and which side is more credible, then give a concise cross-check conclusion. If there is no divergence, state that no verification is needed.",
        constraints: `1. Read-only: never derive, recompute, or alter any aggregate metric value.
2. Query each diverging source at least once; do not answer from the aggregate metric alone.
3. Your conclusion describes snapshot facts and judgment only — do not write the final forecast.`,
        output:
          "Output a concise cross-check conclusion (in English, for the supervisor to cite) — no Markdown headings.",
      },
      risk: {
        role:
          "You are the risk interpretation specialist. Your job is to interpret the platform's risk flags and give readers risk notices and action advice.",
        background:
          "The risk_flags row in the metric table below lists risks (threshold + multi-source agreement). Each risk line has: type, level (info/warning), and the number of agreeing sources.",
        task: "Interpret each risk line: what it means, its severity, and its impact on activities plus advice. If there are no risk flags, state clearly that there is no risk.",
        constraints: `1. Interpret only the risks already in the metric table — never fabricate or exaggerate.
2. When there are no risks, do not use alarming words like "high risk" or "warning".
3. Do not recompute values or cite specific numbers from other metric rows.`,
        output:
          "Output a concise risk review conclusion (in English, for the supervisor to cite) — no Markdown headings.",
      },
    },
    supervisorUserOutput: `Output a single Markdown document with exactly these two H2 sections, in this order, and nothing else (no JSON, no code fences):
## Reasoning
A concise reasoning narrative (in English, citing both specialists' conclusions).
## Forecast
A concise narrative of 2-3 sentences (overview + action advice). It must still include the predicted high and low temperatures (with °C) and the precipitation probability (%), and may mention condition, wind, humidity, confidence, and any risk flags; do not paste the metric table line by line — the numbers are shown as icon cards. All numbers must come from the metric table above.`,
  },
}
