import { describe, expect, it } from "vitest"
import {
  BASIC_COMPONENTS,
  BASIC_FUNCTIONS,
  Catalog,
  MessageProcessor,
} from "@a2ui/web_core/v0_9"

import {
  buildForecastCardMessages,
  type ForecastCardMetrics,
} from "./forecast-card"
import { BASIC_CATALOG_ID, type A2uiMessage } from "@/lib/schemas/a2ui"
import { metricTileSchema } from "@/lib/schemas/a2ui-catalog"

// 服务端模板卡片：验证消息串结构（根 Column → 标题 + 每行两张磁贴的 Row）、zh/en 标签与数值映射、
// 高/低温区间说明行、空值跳磁贴、缺城市名兜底。纯函数（输入 metrics + locale → 三条消息），
// 直接断言消息内容即可（rules/testing.md 需测复杂纯函数）。

type CreateSurface = { surfaceId: string; catalogId: string }
type UpdateComponents = {
  surfaceId: string
  components: { id: string; component: string; [k: string]: unknown }[]
}
type UpdateDataModel = {
  surfaceId: string
  path: string
  value: Record<string, string>
}

// 按消息类型从消息串里取对应载荷（builder 固定产 createSurface → updateComponents → updateDataModel）
function createSurfaceOf(msgs: A2uiMessage[]): CreateSurface {
  const m = msgs.find((x) => "createSurface" in x)
  return (m as { createSurface: CreateSurface }).createSurface
}
function componentsOf(msgs: A2uiMessage[]): UpdateComponents {
  const m = msgs.find((x) => "updateComponents" in x)
  return (m as { updateComponents: UpdateComponents }).updateComponents
}
function dataOf(msgs: A2uiMessage[]): UpdateDataModel {
  const m = msgs.find((x) => "updateDataModel" in x)
  return (m as { updateDataModel: UpdateDataModel }).updateDataModel
}

// 磁贴组件查表：id 形如 tile-<key>，value/sub 为 data model path 绑定
function tileOf(msgs: A2uiMessage[], key: string) {
  return componentsOf(msgs).components.find((c) => c.id === `tile-${key}`)
}
function tileLabel(msgs: A2uiMessage[], key: string): string | undefined {
  const tile = tileOf(msgs, key)
  return tile ? (tile.label as string) : undefined
}
function hasTile(msgs: A2uiMessage[], key: string): boolean {
  return !!tileOf(msgs, key)
}
// 值文本从 data model 断言（tile 的 value 均 path 绑定到 /key）
function valueOf(data: UpdateDataModel, key: string): string | undefined {
  return data.value[key]
}

// 全量指标：覆盖 builder 的每一条磁贴生成分支
const fullMetrics: ForecastCardMetrics = {
  predicted_high: 32.4,
  predicted_low: 23.6,
  high_interval: [30, 34],
  low_interval: [22, 26],
  precipitation_probability: 40,
  precip_level: "light",
  condition: "cloudy",
  wind_beaufort: 4,
  humidity: 65,
  confidence: "high",
  risk_flags: [
    { type: "heat", level: "warning", sources: 3 },
    { type: "wind", level: "info", sources: 2 },
  ],
}

// 全 null：应只剩标题，无任何磁贴
const emptyMetrics: ForecastCardMetrics = {
  predicted_high: null,
  predicted_low: null,
  high_interval: null,
  low_interval: null,
  precipitation_probability: null,
  precip_level: null,
  condition: null,
  wind_beaufort: null,
  humidity: null,
  confidence: null,
  risk_flags: null,
}

describe("buildForecastCardMessages 结构", () => {
  it("产出三条消息，顺序 createSurface → updateComponents → updateDataModel", () => {
    const msgs = buildForecastCardMessages(
      { cityName: "上海", metrics: fullMetrics },
      "zh"
    )
    expect(msgs).toHaveLength(3)
    expect(createSurfaceOf(msgs).catalogId).toBe(BASIC_CATALOG_ID)
    expect(createSurfaceOf(msgs).surfaceId).toBe("forecast")
    expect(componentsOf(msgs).surfaceId).toBe("forecast")
    expect(dataOf(msgs).path).toBe("/")
  })

  it("根为 Column（无 Card）→ [标题, 每行两张磁贴的 Row]，标题为城市名", () => {
    const msgs = buildForecastCardMessages(
      { cityName: "东京", metrics: fullMetrics },
      "zh"
    )
    const { components } = componentsOf(msgs)
    const root = components.find((c) => c.id === "root")
    const title = components.find((c) => c.id === "title")
    expect(root?.component).toBe("Column")
    // 子节点 = 标题 + 9 张磁贴按两列分 5 行
    expect(root?.children).toEqual([
      "title",
      "row-0",
      "row-1",
      "row-2",
      "row-3",
      "row-4",
    ])
    expect(title).toMatchObject({
      component: "Text",
      text: "东京",
      variant: "h4",
      weight: 600,
    })
    // 每行 Row 引用两张真实存在的磁贴组件
    for (const rowId of ["row-0", "row-1", "row-2", "row-3", "row-4"]) {
      const row = components.find((c) => c.id === rowId)
      expect(row?.component).toBe("Row")
      const childIds = row?.children as string[]
      expect(childIds).toHaveLength(rowId === "row-4" ? 1 : 2)
      for (const id of childIds) {
        const tile = components.find((c) => c.id === id)
        expect(tile?.component).toBe("MetricTile")
        expect(tile?.value).toEqual({ path: `/${id.replace("tile-", "")}` })
      }
    }
  })

  it("data model 里每张磁贴均有值，高/低温附区间说明行", () => {
    const msgs = buildForecastCardMessages(
      { cityName: "上海", metrics: fullMetrics },
      "zh"
    )
    const data = dataOf(msgs)
    for (const key of [
      "high",
      "low",
      "precip",
      "precipLevel",
      "condition",
      "wind",
      "humidity",
      "confidence",
      "risk",
    ]) {
      expect(data.value[key], `磁贴 ${key} 缺值`).toBeTruthy()
    }
    expect(data.value.highInterval).toBe("30 ~ 34 °C")
    expect(data.value.lowInterval).toBe("22 ~ 26 °C")
    // 非区间磁贴无说明行
    expect(data.value.precipInterval).toBeUndefined()
  })
})

describe("buildForecastCardMessages zh 标签与映射", () => {
  const msgs = buildForecastCardMessages(
    { cityName: "上海", metrics: fullMetrics },
    "zh"
  )
  const data = dataOf(msgs)

  it("中文标签 + 数值格式（温度取整、百分比、风级）", () => {
    expect(tileLabel(msgs, "condition")).toBe("天气")
    expect(tileLabel(msgs, "high")).toBe("最高")
    expect(tileLabel(msgs, "low")).toBe("最低")
    expect(tileLabel(msgs, "precip")).toBe("降水")
    expect(tileLabel(msgs, "precipLevel")).toBe("等级")
    expect(tileLabel(msgs, "humidity")).toBe("湿度")
    expect(tileLabel(msgs, "wind")).toBe("风力")
    expect(tileLabel(msgs, "confidence")).toBe("可信度")
    expect(tileLabel(msgs, "risk")).toBe("风险")
  })

  it("数值取整显示（32.4 → 32°C、40 → 40%）与文案复用平台口径", () => {
    expect(valueOf(data, "high")).toBe("32°C")
    expect(valueOf(data, "low")).toBe("24°C")
    expect(valueOf(data, "precip")).toBe("40%")
    expect(valueOf(data, "precipLevel")).toBe("小雨")
    expect(valueOf(data, "humidity")).toBe("65%")
    expect(valueOf(data, "wind")).toBe("4 级")
    expect(valueOf(data, "condition")).toBe("阴")
    expect(valueOf(data, "confidence")).toBe("高")
  })

  it("风险标记按「类型（级别）」逐条拼接", () => {
    expect(valueOf(data, "risk")).toBe("高温（警告）、大风（提醒）")
  })

  it("磁贴 icon/chip 语义键与状况图标映射", () => {
    expect(tileOf(msgs, "high")).toMatchObject({
      icon: "thermHigh",
      chip: "amber",
    })
    expect(tileOf(msgs, "low")).toMatchObject({ icon: "thermLow", chip: "sky" })
    expect(tileOf(msgs, "condition")).toMatchObject({
      icon: "cloud",
      chip: "indigo",
    })
    expect(tileOf(msgs, "risk")).toMatchObject({
      icon: "shieldAlert",
      chip: "rose",
    })
  })
})

describe("buildForecastCardMessages en 标签与映射", () => {
  const msgs = buildForecastCardMessages(
    { cityName: "Tokyo", metrics: fullMetrics },
    "en"
  )
  const data = dataOf(msgs)

  it("英文标签 + Bft 风级", () => {
    expect(tileLabel(msgs, "condition")).toBe("Condition")
    expect(tileLabel(msgs, "high")).toBe("High")
    expect(tileLabel(msgs, "low")).toBe("Low")
    expect(tileLabel(msgs, "precip")).toBe("Precip")
    expect(tileLabel(msgs, "precipLevel")).toBe("Level")
    expect(tileLabel(msgs, "humidity")).toBe("Humidity")
    expect(tileLabel(msgs, "wind")).toBe("Wind")
    expect(tileLabel(msgs, "confidence")).toBe("Confidence")
    expect(tileLabel(msgs, "risk")).toBe("Risk")
    expect(valueOf(data, "wind")).toBe("Bft 4")
    expect(valueOf(data, "condition")).toBe("Cloudy")
    expect(valueOf(data, "confidence")).toBe("High")
    expect(valueOf(data, "precipLevel")).toBe("Light")
    expect(valueOf(data, "high")).toBe("32°C")
  })

  it("风险标记 en 用括号与逗号拼接", () => {
    expect(valueOf(data, "risk")).toBe("Heat (warning), Wind (info)")
  })
})

describe("buildForecastCardMessages 渲染可解析（真实 MessageProcessor）", () => {
  // 走与客户端 a2ui-catalog 同源 schema 的组件表（含自定义 MetricTile）+ 真实处理管线，验证：
  // 1) processMessages 不抛错（catalog 命中、MetricTile 严格校验通过）；
  // 2) 所有容器（Row、Column）按 id 引用的子组件都真实存在。
  // 曾出现把虚拟行 id 塞进容器 children、渲染器找不到组件回退成 [Loading row-...] 的 bug，
  // 纯结构断言查不出，须用解析层校验。
  const catalog = new Catalog(
    BASIC_CATALOG_ID,
    [...BASIC_COMPONENTS, { name: "MetricTile", schema: metricTileSchema }],
    BASIC_FUNCTIONS
  )

  it("全量指标消息可被处理，容器引用的子组件全部存在", () => {
    const msgs = buildForecastCardMessages(
      { cityName: "上海", metrics: fullMetrics },
      "zh"
    )
    const proc = new MessageProcessor([catalog])
    expect(() => proc.processMessages(msgs)).not.toThrow()
    expect(proc.model.getSurface("forecast")).toBeDefined()

    const { components } = componentsOf(msgs)
    const ids = new Set(components.map((c) => c.id))
    for (const comp of components) {
      const refs: string[] = []
      if (typeof comp.child === "string") refs.push(comp.child)
      if (Array.isArray(comp.children))
        refs.push(...(comp.children as string[]))
      for (const ref of refs) {
        expect(
          ids.has(ref),
          `组件 ${comp.id} 引用了不存在的子组件 ${ref}`
        ).toBe(true)
      }
    }
  })

  it("空指标消息只有标题，无可悬空的子引用", () => {
    const msgs = buildForecastCardMessages(
      { cityName: null, metrics: emptyMetrics },
      "zh"
    )
    const proc = new MessageProcessor([catalog])
    expect(() => proc.processMessages(msgs)).not.toThrow()
    const { components } = componentsOf(msgs)
    const ids = new Set(components.map((c) => c.id))
    for (const comp of components) {
      if (typeof comp.child === "string") {
        expect(ids.has(comp.child)).toBe(true)
      }
      if (Array.isArray(comp.children)) {
        for (const ref of comp.children as string[])
          expect(ids.has(ref)).toBe(true)
      }
    }
  })
})

describe("buildForecastCardMessages 空值与兜底", () => {
  it("全空指标：只有标题，无任何磁贴", () => {
    const msgs = buildForecastCardMessages(
      { cityName: "上海", metrics: emptyMetrics },
      "zh"
    )
    const data = dataOf(msgs)
    expect(Object.keys(data.value)).toHaveLength(0)
    const { components } = componentsOf(msgs)
    const children = components.find((c) => c.id === "root")
      ?.children as string[]
    expect(children).toEqual(["title"])
    expect(components.some((c) => c.id.startsWith("tile-"))).toBe(false)
  })

  it("个别字段为 null 时只跳过该磁贴", () => {
    const partial: ForecastCardMetrics = {
      ...emptyMetrics,
      predicted_high: 32.6,
      condition: "rain",
    }
    const msgs = buildForecastCardMessages(
      { cityName: "上海", metrics: partial },
      "zh"
    )
    const data = dataOf(msgs)
    expect(Object.keys(data.value).sort()).toEqual(["condition", "high"])
    expect(hasTile(msgs, "low")).toBe(false)
    expect(hasTile(msgs, "risk")).toBe(false)
  })

  it("高/低温存在但区间缺失 → 磁贴无说明行（sub 不绑定）", () => {
    // predicted_low 非空但 low_interval 为空：低磁贴应照常出现、只是不带区间说明
    const partial: ForecastCardMetrics = {
      ...emptyMetrics,
      predicted_high: 30,
      predicted_low: 20,
    }
    const msgs = buildForecastCardMessages(
      { cityName: "上海", metrics: partial },
      "zh"
    )
    const data = dataOf(msgs)
    expect(hasTile(msgs, "high")).toBe(true)
    expect(hasTile(msgs, "low")).toBe(true)
    expect(data.value.highInterval).toBeUndefined()
    expect(data.value.lowInterval).toBeUndefined()
  })

  it("缺城市名：标题用「今日预报」兜底", () => {
    const zh = buildForecastCardMessages(
      { cityName: null, metrics: fullMetrics },
      "zh"
    )
    const en = buildForecastCardMessages(
      { cityName: null, metrics: fullMetrics },
      "en"
    )
    const titleZh = componentsOf(zh).components.find((c) => c.id === "title")
    const titleEn = componentsOf(en).components.find((c) => c.id === "title")
    expect(titleZh?.text).toBe("今日预报")
    expect(titleEn?.text).toBe("Today's forecast")
  })

  it("未知枚举回退原始字符串（不报错）", () => {
    const weird: ForecastCardMetrics = {
      ...emptyMetrics,
      condition: "hazy",
      confidence: "definitely",
    }
    const msgs = buildForecastCardMessages(
      { cityName: "上海", metrics: weird },
      "zh"
    )
    const data = dataOf(msgs)
    expect(valueOf(data, "condition")).toBe("hazy")
    expect(valueOf(data, "confidence")).toBe("definitely")
  })
})
