import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fetchJson } from "@/lib/weather/http"

import {
  buildModelsUrl,
  clearModelConfig,
  configKey,
  getModelConfig,
  loadModels,
  saveModelConfig,
  subscribeModelConfig,
  ModelConfigError,
} from "./model-config"

// mock 统一 fetch 封装，逐分支验证 loadModels 的转发与错误归并
vi.mock("@/lib/weather/http", () => ({ fetchJson: vi.fn() }))

const EMAIL = "User@Example.com"
const CONFIG = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-123",
  model: "gpt-4o",
  models: ["gpt-4o"],
}

describe("configKey", () => {
  it("邮箱小写去空格归一", () => {
    expect(configKey(EMAIL)).toBe("modelConfig:user@example.com")
  })

  it("空邮箱回退全局键", () => {
    expect(configKey("")).toBe("modelConfig")
    expect(configKey("   ")).toBe("modelConfig")
  })
})

describe("存储", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it("save 后 get 等值往返", () => {
    saveModelConfig(EMAIL, CONFIG)
    expect(getModelConfig(EMAIL)).toEqual(CONFIG)
  })

  it("clear 后 get 为 null", () => {
    saveModelConfig(EMAIL, CONFIG)
    clearModelConfig(EMAIL)
    expect(getModelConfig(EMAIL)).toBeNull()
  })

  it("存储未变时重复读取返回同一引用（快照缓存）", () => {
    saveModelConfig(EMAIL, CONFIG)
    const first = getModelConfig(EMAIL)
    const second = getModelConfig(EMAIL)
    // 先验值正确，再验引用稳定——否则跨用例 memo 污染会让 toBe 空通过
    expect(first).toEqual(CONFIG)
    expect(second).toBe(first)
  })

  it("不同邮箱隔离", () => {
    saveModelConfig(EMAIL, CONFIG)
    expect(getModelConfig("other@example.com")).toBeNull()
  })

  it("损坏 JSON 视为未配置", () => {
    localStorage.setItem(configKey(EMAIL), "{oops")
    expect(getModelConfig(EMAIL)).toBeNull()
  })

  it("形状不合法视为未配置", () => {
    localStorage.setItem(configKey(EMAIL), JSON.stringify({ baseUrl: 123 }))
    expect(getModelConfig(EMAIL)).toBeNull()
  })

  it("无 window 时安全降级", () => {
    vi.stubGlobal("window", undefined)
    try {
      expect(getModelConfig(EMAIL)).toBeNull()
      expect(() => saveModelConfig(EMAIL, CONFIG)).not.toThrow()
      expect(() => clearModelConfig(EMAIL)).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("ModelConfigError", () => {
  it("携带错误码且是 Error 实例", () => {
    const err = new ModelConfigError("http")
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("http")
    expect(err.name).toBe("ModelConfigError")
  })
})

describe("subscribeModelConfig", () => {
  it("保存时通知订阅者，退订后不再通知", () => {
    const spy = vi.fn()
    const unsub = subscribeModelConfig(spy)
    saveModelConfig(EMAIL, CONFIG)
    expect(spy).toHaveBeenCalledTimes(1)

    unsub()
    saveModelConfig(EMAIL, CONFIG)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe("buildModelsUrl", () => {
  it("追加 /models", () => {
    expect(buildModelsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/models"
    )
  })

  it("去尾斜杠", () => {
    expect(buildModelsUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/models"
    )
  })

  it("已带 /models 不重复拼接", () => {
    expect(buildModelsUrl("https://api.example.com/v1/models")).toBe(
      "https://api.example.com/v1/models"
    )
  })

  it("/models/ 归一", () => {
    expect(buildModelsUrl("https://api.example.com/v1/models/")).toBe(
      "https://api.example.com/v1/models"
    )
  })

  it("去掉首尾空白", () => {
    expect(buildModelsUrl("  https://api.example.com/v1  ")).toBe(
      "https://api.example.com/v1/models"
    )
  })

  it("多个尾斜杠全部去掉", () => {
    expect(buildModelsUrl("https://api.example.com/v1//")).toBe(
      "https://api.example.com/v1/models"
    )
  })

  it("中间含 /models 但非结尾时仍追加", () => {
    expect(buildModelsUrl("https://api.example.com/v1/models-extra")).toBe(
      "https://api.example.com/v1/models-extra/models"
    )
  })
})

describe("loadModels", () => {
  beforeEach(() => vi.mocked(fetchJson).mockReset())

  it("成功返回模型 id，携带 Bearer 头并指向 /models", async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      json: { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] },
    })
    expect(await loadModels("https://api.example.com/v1", "sk-123")).toEqual({
      ok: true,
      models: ["gpt-4o", "gpt-4o-mini"],
    })
    expect(fetchJson).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      { headers: { Authorization: "Bearer sk-123" } }
    )
  })

  it("非 2xx 归 http", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok: false, error: "http" })
    expect(await loadModels("https://api.example.com/v1", "sk")).toEqual({
      ok: false,
      error: "http",
    })
  })

  it("断网归 network", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok: false, error: "network" })
    expect(await loadModels("https://api.example.com/v1", "sk")).toEqual({
      ok: false,
      error: "network",
    })
  })

  it("模型项缺 id 归 parse", async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      json: { data: [{ nope: 1 }] },
    })
    expect(await loadModels("https://api.example.com/v1", "sk")).toEqual({
      ok: false,
      error: "parse",
    })
  })

  it("data 缺失归 parse", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok: true, json: { foo: "bar" } })
    expect(await loadModels("https://api.example.com/v1", "sk")).toEqual({
      ok: false,
      error: "parse",
    })
  })
})
