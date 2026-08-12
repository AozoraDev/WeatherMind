import type { RiskFlag } from "@/lib/schemas/forecast-agent"
import { TEXTS } from "@/lib/forecast-agent/agent/prompt-text"
import {
  BASIC_CATALOG_ID,
  type A2uiComponent,
  type A2uiMessage,
} from "@/lib/schemas/a2ui"

// 服务端把「主 Agent 工具观察里的权威预报数据」模板化成 A2UI 卡片消息。
// 关键设计：数值完全来自工具返回（模型不生成 UI、不转述数值），卡片只是把这些确定性指标
// 以 a2ui v0.9 消息形式（createSurface → updateComponents → updateDataModel）组织出来，
// 客户端用 @a2ui/react basicCatalog + 自定义 MetricTile 组件渲染。标签文案复用 forecast-agent
// 的本地化表（prompt-text），保证口径与预报正文一致；构建失败由调用方降级为纯 markdown（不阻塞回复）。
//
// 布局借预报页 ForecastAgentCard 的指标图标卡：每项一个彩色图标块 + 标签 + 数值的磁贴，两列一组
// 由 Row 排布。icon/chip 是客户端 a2ui-catalog 映射到 lucide + 配色的语义键；label 静态文案，
// value/sub 走 data model path 绑定（结构与数据分离）。MetricTile 的 schema 严格校验见
// lib/schemas/a2ui.ts，服务端模板必须与其对齐。

// 卡片展示的指标子集（与 tools.ts forecastRowToObservation 的 metrics 形状对齐）
export type ForecastCardMetrics = {
  predicted_high: number | null
  predicted_low: number | null
  high_interval: [number, number] | null
  low_interval: [number, number] | null
  precipitation_probability: number | null
  precip_level: string | null
  condition: string | null
  wind_beaufort: number | null
  humidity: number | null
  confidence: string | null
  risk_flags: RiskFlag[] | null
}

export type ForecastCardInput = {
  cityName: string | null // 城市显示名（capture 已按 locale 取 name_ja/name_en），缺省时标题用「今日预报」兜底
  metrics: ForecastCardMetrics
}

// 卡片磁贴标签（短名词，与提示词里的指标全称区分；值文案走 TEXTS 复用平台口径）
const LABELS: Record<
  "zh" | "en",
  {
    condition: string
    high: string
    low: string
    precip: string
    precipLevel: string
    humidity: string
    wind: string
    confidence: string
    risk: string
  }
> = {
  zh: {
    condition: "天气",
    high: "最高",
    low: "最低",
    precip: "降水",
    precipLevel: "等级",
    humidity: "湿度",
    wind: "风力",
    confidence: "可信度",
    risk: "风险",
  },
  en: {
    condition: "Condition",
    high: "High",
    low: "Low",
    precip: "Precip",
    precipLevel: "Level",
    humidity: "Humidity",
    wind: "Wind",
    confidence: "Confidence",
    risk: "Risk",
  },
}

// 单条 surface 的 id：每条消息的客户端 MessageProcessor 相互独立，常量即可
const SURFACE_ID = "forecast"

// 数值取整显示（口径与预报正文一致），空值行由调用方按 null 跳过
const fmtTemp = (n: number) => `${Math.round(n)}°C`
const fmtPercent = (n: number) => `${Math.round(n)}%`
// 高/低温区间作为磁贴说明行显示
const fmtInterval = (iv: [number, number]) =>
  `${Math.round(iv[0])} ~ ${Math.round(iv[1])} °C`

// 按 catalog 中的组件类型安全取值（未知枚举回退原始字符串，不报错）
const lookup = (table: Record<string, string>, key: string) => table[key] ?? key

// 天气状况分类 → 磁贴图标语义键（与 ForecastMetricsGrid 的 condition → 图标一致）；未知回退 cloud
const CONDITION_ICON: Record<string, string> = {
  clear: "sun",
  partlyCloudy: "cloudsun",
  cloudy: "cloud",
  fog: "fog",
  rain: "rain",
  snow: "snow",
  storm: "storm",
  other: "cloudy",
}

export function buildForecastCardMessages(
  input: ForecastCardInput,
  locale: "zh" | "en"
): A2uiMessage[] {
  const t = TEXTS[locale]
  const labels = LABELS[locale]
  const m = input.metrics

  // 磁贴定义（值同时写入 data model，组件内走 path 绑定）；icon/chip 为语义键
  const tiles: {
    key: string
    icon: string
    chip: string
    label: string
    sub?: string
  }[] = []
  const data: Record<string, string> = {}

  const pushTile = (
    key: string,
    icon: string,
    chip: string,
    label: string,
    value: string | null | undefined,
    sub?: string
  ) => {
    if (value === null || value === undefined || value === "") return
    data[key] = value
    if (sub) data[`${key}Interval`] = sub
    tiles.push({ key, icon, chip, label, ...(sub ? { sub } : {}) })
  }

  // 固定顺序（与预报页指标图标卡一致）：高/低温（带区间说明）→ 降水概率/等级 → 状况 → 风力
  // → 湿度 → 可信度 → 风险
  if (m.predicted_high != null) {
    pushTile(
      "high",
      "thermHigh",
      "amber",
      labels.high,
      fmtTemp(m.predicted_high),
      m.high_interval ? fmtInterval(m.high_interval) : undefined
    )
  }
  if (m.predicted_low != null) {
    pushTile(
      "low",
      "thermLow",
      "sky",
      labels.low,
      fmtTemp(m.predicted_low),
      m.low_interval ? fmtInterval(m.low_interval) : undefined
    )
  }
  if (m.precipitation_probability != null) {
    pushTile(
      "precip",
      "rain",
      "blue",
      labels.precip,
      fmtPercent(m.precipitation_probability)
    )
  }
  if (m.precip_level) {
    pushTile(
      "precipLevel",
      "umbrella",
      "cyan",
      labels.precipLevel,
      lookup(t.precipLevel as Record<string, string>, m.precip_level)
    )
  }
  if (m.condition) {
    pushTile(
      "condition",
      CONDITION_ICON[m.condition] ?? "cloud",
      "indigo",
      labels.condition,
      lookup(t.condition as Record<string, string>, m.condition)
    )
  }
  if (m.wind_beaufort != null) {
    pushTile(
      "wind",
      "wind",
      "teal",
      labels.wind,
      t.windValue.replace("{n}", String(m.wind_beaufort))
    )
  }
  if (m.humidity != null) {
    pushTile("humidity", "droplets", "emerald", labels.humidity, fmtPercent(m.humidity))
  }
  if (m.confidence) {
    pushTile(
      "confidence",
      "gauge",
      "violet",
      labels.confidence,
      lookup(t.confidence as Record<string, string>, m.confidence)
    )
  }
  // 风险磁贴：逐条「类型（级别）」拼接，多源一致展示在同行（值较长，自然换行）
  const risks = m.risk_flags
  if (risks && risks.length > 0) {
    const riskText = risks
      .map((r) => {
        const name = lookup(t.risk as Record<string, string>, r.type)
        const level = lookup(t.riskLevel as Record<string, string>, r.level)
        return locale === "zh" ? `${name}（${level}）` : `${name} (${level})`
      })
      .join(locale === "zh" ? "、" : ", ")
    pushTile("risk", "shieldAlert", "rose", labels.risk, riskText)
  }

  // 组件树：根 Column（无 Card，背景由宿主绿色渐变透出）→ 标题 + 每行两张磁贴的 Row
  const components: A2uiComponent[] = []
  const rowIds: string[] = []
  for (let i = 0; i < tiles.length; i += 2) {
    const pair = tiles.slice(i, i + 2)
    const rowId = `row-${i / 2}`
    rowIds.push(rowId)
    const childIds: string[] = []
    for (const tile of pair) {
      const id = `tile-${tile.key}`
      childIds.push(id)
      components.push({
        id,
        component: "MetricTile",
        icon: tile.icon,
        chip: tile.chip,
        label: tile.label,
        value: { path: `/${tile.key}` },
        ...(tile.sub ? { sub: { path: `/${tile.key}Interval` } } : {}),
      })
    }
    components.push({ id: rowId, component: "Row", children: childIds })
  }

  const titleText = input.cityName ?? (locale === "zh" ? "今日预报" : "Today's forecast")
  const title: A2uiComponent = {
    id: "title",
    component: "Text",
    text: titleText,
    variant: "h4",
    weight: 600,
  }
  const root: A2uiComponent = {
    id: "root",
    component: "Column",
    children: ["title", ...rowIds],
  }
  components.push(title, root)

  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: SURFACE_ID, catalogId: BASIC_CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: SURFACE_ID,
        components,
      },
    },
    {
      version: "v0.9",
      updateDataModel: { surfaceId: SURFACE_ID, path: "/", value: data },
    },
  ]
}
