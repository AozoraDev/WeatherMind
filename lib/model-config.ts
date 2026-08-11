import { z } from "zod"

import { modelConfigSchema, modelsResponseSchema } from "@/lib/schemas/ai"
import { fetchJson } from "@/lib/weather/http"

// AI 模型配置：按邮箱隔离存 localStorage，退出登录由客户端清除（见 logout-button）。
// 所有读写带 SSR 守卫——预渲染时 window 未定义，静默降级为「未配置」。

export type ModelConfig = z.infer<typeof modelConfigSchema> & {
  models: string[]
}

// 客户端测试/保存动作的错误码：mutationFn 抛 ModelConfigError 供 i18n 取文案
export type ModelConfigErrorCode = "network" | "http" | "parse"

export class ModelConfigError extends Error {
  code: ModelConfigErrorCode
  constructor(code: ModelConfigErrorCode) {
    super(code)
    this.name = "ModelConfigError"
    this.code = code
  }
}

const STORAGE_PREFIX = "modelConfig:"

// 已存配置视为外部数据先过一遍 schema，防旧格式/手工篡改（键缺失即未配置）
const storedConfigSchema = modelConfigSchema.extend({
  models: z.array(z.string()),
})

// 存储键：邮箱小写归一避免同一邮箱不同大小写各存一份；空邮箱回退全局键
export function configKey(email: string): string {
  const id = email.trim().toLowerCase()
  return id ? `${STORAGE_PREFIX}${id}` : STORAGE_PREFIX.replace(":", "")
}

// 订阅集合：保存/清除时通知 useSyncExternalStore 订阅方联动刷新
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

// 订阅本地配置变化，返回取消订阅函数（供 hooks/use-model-config 使用）
export function subscribeModelConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// 快照缓存：按 key+原文缓存解析结果，同一内容返回同一引用，
// 供 useSyncExternalStore 的 getSnapshot 使用，避免每次返回新对象导致无限重渲染
let memoKey = ""
let memoRaw: string | null = null
let memoValue: ModelConfig | null = null

export function getModelConfig(email: string): ModelConfig | null {
  if (typeof window === "undefined") return null // SSR/预渲染兜底
  const key = configKey(email)
  const raw = window.localStorage.getItem(key)
  if (key === memoKey && raw === memoRaw) return memoValue
  let value: ModelConfig | null = null
  try {
    if (raw) {
      const parsed = storedConfigSchema.safeParse(JSON.parse(raw))
      if (parsed.success) value = parsed.data
    }
  } catch {
    value = null // JSON 损坏视为未配置
  }
  memoKey = key
  memoRaw = raw
  memoValue = value
  return value
}

export function saveModelConfig(email: string, config: ModelConfig): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(configKey(email), JSON.stringify(config))
  emit()
}

export function clearModelConfig(email: string): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(configKey(email))
  emit()
}

// 组装 /models 地址：去尾斜杠，已带 /models 不重复拼接
export function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  if (/\/models$/i.test(trimmed)) return trimmed
  return `${trimmed}/models`
}

export type LoadModelsResult =
  { ok: true; models: string[] } | { ok: false; error: ModelConfigErrorCode }

// 调 OpenAI 兼容 /models：走统一 fetchJson 封装，失败/格式异常归对应错误码，绝不抛错
export async function loadModels(
  baseUrl: string,
  apiKey: string
): Promise<LoadModelsResult> {
  const res = await fetchJson(buildModelsUrl(baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) return { ok: false, error: res.error }

  const parsed = modelsResponseSchema.safeParse(res.json)
  if (!parsed.success) return { ok: false, error: "parse" }
  return { ok: true, models: parsed.data.data.map((m) => m.id) }
}
