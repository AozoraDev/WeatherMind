import { describe, expect, it } from "vitest"
import { scrapeSchemaBehavior } from "@a2ui/web_core/v0_9"

import { metricTileSchema } from "./a2ui-catalog"

// zod 信任边界测试：MetricTile 组件 schema 的缺失/非法/未知字段（rules/testing.md 需测 Zod 边界）。
// 服务端模板（forecast-card.ts）发出的磁贴消息必须通过此严格校验，客户端 MessageProcessor 依此拒绝漂移。
// 另测 binder 行为树：value/sub 必须是 DYNAMIC（path 绑定能解析到 data model），这是对 zod 版本的回归
// 守卫——web_core 的 GenericBinder 靠 `_def.typeName`（v3 zod）识别动态字符串，若 schema 换回 v4 zod
// 会被当成 STATIC 渲染成 [object Object]，本断言即失败。

const validTile = {
  icon: "thermHigh",
  chip: "amber",
  label: "最高",
  value: { path: "/high" },
}

describe("metricTileSchema", () => {
  it("binder 行为树：value/sub 为 DYNAMIC、icon 为 STATIC（path 绑定生效）", () => {
    const behavior = scrapeSchemaBehavior(metricTileSchema)
    expect(behavior.type).toBe("OBJECT")
    if (behavior.type === "OBJECT") {
      expect(behavior.shape.value.type).toBe("DYNAMIC")
      expect(behavior.shape.sub.type).toBe("DYNAMIC")
      expect(behavior.shape.icon.type).toBe("STATIC")
    }
  })

  it("合法磁贴通过：value 为 path 绑定或普通字符串", () => {
    expect(metricTileSchema.safeParse(validTile).success).toBe(true)
    expect(
      metricTileSchema.safeParse({ ...validTile, value: "32°C" }).success
    ).toBe(true)
    // sub 可选：缺省或带 path 绑定均可
    expect(metricTileSchema.safeParse(validTile).success).toBe(true)
    expect(
      metricTileSchema.safeParse({
        ...validTile,
        sub: { path: "/highInterval" },
      }).success
    ).toBe(true)
  })

  it("缺失 icon/chip/label → 失败", () => {
    for (const key of ["icon", "chip", "label"] as const) {
      const rest: Partial<typeof validTile> = { ...validTile }
      delete rest[key]
      expect(metricTileSchema.safeParse(rest).success).toBe(false)
    }
  })

  it("value 非法（数字、未知对象）→ 失败", () => {
    expect(
      metricTileSchema.safeParse({ ...validTile, value: 42 }).success
    ).toBe(false)
    expect(
      metricTileSchema.safeParse({ ...validTile, value: { foo: "bar" } })
        .success
    ).toBe(false)
    // 空 path 是 web_core DynamicStringSchema 自身的宽松行为（path 未设 min），非本 schema 边界
  })

  it("未知字段 → 失败（strict）", () => {
    expect(metricTileSchema.safeParse({ ...validTile, extra: 1 }).success).toBe(
      false
    )
  })
})
