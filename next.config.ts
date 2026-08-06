import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

// 启用 root-params（Next 16.3+ 默认开启，16.2 需显式打开），供 i18n 取当前 locale
const withNextIntl = createNextIntlPlugin()

const nextConfig: NextConfig = {
  experimental: {
    rootParams: true,
  },
}

export default withNextIntl(nextConfig)
