import { fileURLToPath } from "node:url"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// Vitest 配置：jsdom 环境 + jest-dom 断言，@ 别名对齐 tsconfig
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      // v8 覆盖率：lcov 供 codecov 上传，text 供 CI 日志查看
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      // 只统计 lib/ 与 supabase/ 下的业务逻辑；生成/配置类文件排除，保证数字真实
      include: ["lib/**", "supabase/**"],
      // 测试共享夹具（fakeSupabase 等）不属于被测业务，不计入覆盖率
      exclude: [
        "**/*.test.*",
        "**/*.d.ts",
        "**/*.config.*",
        "**/*.sql",
        "**/test-utils.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
})
