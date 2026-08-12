import { describe, expect, it } from "vitest"

import { a2uiMessageSchema, a2uiMessagesSchema, BASIC_CATALOG_ID } from "./a2ui"

// zod 信任边界测试：消息信封结构/缺版本/未知消息/组件缺字段（rules/testing.md 需测 Zod 边界）
const createSurface = {
  version: "v0.9",
  createSurface: { surfaceId: "forecast", catalogId: BASIC_CATALOG_ID },
}

const updateComponents = {
  version: "v0.9",
  updateComponents: {
    surfaceId: "forecast",
    components: [
      { id: "card", component: "Card", child: "root" },
      { id: "root", component: "Column", children: ["title"] },
      { id: "title", component: "Text", text: "上海", variant: "h4", weight: 600 },
    ],
  },
}

const updateDataModel = {
  version: "v0.9",
  updateDataModel: { surfaceId: "forecast", path: "/", value: { high: "32°C" } },
}

describe("a2uiMessageSchema", () => {
  it("三类消息信封均通过", () => {
    expect(a2uiMessageSchema.safeParse(createSurface).success).toBe(true)
    expect(a2uiMessageSchema.safeParse(updateComponents).success).toBe(true)
    expect(a2uiMessageSchema.safeParse(updateDataModel).success).toBe(true)
    expect(
      a2uiMessageSchema.safeParse({
        version: "v0.9",
        deleteSurface: { surfaceId: "forecast" },
      }).success
    ).toBe(true)
  })

  it("缺失 version → 失败", () => {
    expect(
      a2uiMessageSchema.safeParse({ createSurface: createSurface.createSurface })
        .success
    ).toBe(false)
  })

  it("版本越界（非 v0.9）→ 失败", () => {
    expect(
      a2uiMessageSchema.safeParse({
        version: "v0.8",
        createSurface: createSurface.createSurface,
      }).success
    ).toBe(false)
  })

  it("未知消息类型 → 失败", () => {
    expect(
      a2uiMessageSchema.safeParse({ version: "v0.9", unknown: { x: 1 } }).success
    ).toBe(false)
  })

  it("createSurface 缺 catalogId → 失败", () => {
    expect(
      a2uiMessageSchema.safeParse({
        version: "v0.9",
        createSurface: { surfaceId: "forecast" },
      }).success
    ).toBe(false)
  })

  it("updateComponents 组件为空数组 → 失败", () => {
    expect(
      a2uiMessageSchema.safeParse({
        version: "v0.9",
        updateComponents: { surfaceId: "forecast", components: [] },
      }).success
    ).toBe(false)
  })

  it("组件缺 component 名 → 失败", () => {
    expect(
      a2uiMessageSchema.safeParse({
        version: "v0.9",
        updateComponents: { surfaceId: "forecast", components: [{ id: "x" }] },
      }).success
    ).toBe(false)
  })

  it("updateDataModel 缺 surfaceId → 失败", () => {
    expect(
      a2uiMessageSchema.safeParse({
        version: "v0.9",
        updateDataModel: { path: "/", value: {} },
      }).success
    ).toBe(false)
  })
})

describe("a2uiMessagesSchema", () => {
  it("完整卡片消息串通过", () => {
    expect(
      a2uiMessagesSchema.safeParse([createSurface, updateComponents, updateDataModel])
        .success
    ).toBe(true)
  })

  it("混入非法消息 → 整体失败", () => {
    expect(
      a2uiMessagesSchema.safeParse([createSurface, { version: "v0.8", foo: 1 }])
        .success
    ).toBe(false)
  })
})
