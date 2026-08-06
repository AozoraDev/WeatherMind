import { defineRouting } from "next-intl/routing"

// 支持的语言与默认语言：中文站为默认，/ 前缀即中文，英文走 /en
export const routing = defineRouting({
  locales: ["zh", "en"],
  defaultLocale: "zh",
  localePrefix: "as-needed",
})
