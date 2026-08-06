import { createNavigation } from "next-intl/navigation"

import { routing } from "./routing"

// 类型化的导航工具：自动处理 locale 前缀，页面内跳转统一走这里，不手拼 URL
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing)
