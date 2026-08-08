import { useSyncExternalStore } from "react"

import {
  getModelConfig,
  subscribeModelConfig,
  type ModelConfig,
} from "@/lib/model-config"

// 订阅本地模型配置：SSR 阶段 getServerSnapshot 恒返回 null 与首屏一致，
// 挂载后读 localStorage，保存/清除时经订阅自动刷新——替代手写 effect+setState
export function useModelConfig(email: string): ModelConfig | null {
  return useSyncExternalStore(
    subscribeModelConfig,
    () => getModelConfig(email),
    () => null
  )
}
