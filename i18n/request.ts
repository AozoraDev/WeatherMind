import * as rootParams from "next/root-params"
import { notFound } from "next/navigation"
import { hasLocale } from "next-intl"
import { getRequestConfig } from "next-intl/server"

import { routing } from "./routing"

// 每个请求的 i18n 配置：从路由参数取 locale，未匹配到支持语言时走 404
export default getRequestConfig(async ({ locale }) => {
  if (!locale) {
    const paramValue = await rootParams.locale()
    if (hasLocale(routing.locales, paramValue)) {
      locale = paramValue
    } else {
      notFound()
    }
  }

  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  }
})
