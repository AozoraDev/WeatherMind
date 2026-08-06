import { Geist, Geist_Mono } from "next/font/google"
import { hasLocale, NextIntlClientProvider } from "next-intl"
import { getMessages, getTranslations } from "next-intl/server"

import { QueryProvider } from "@/components/providers/query-provider"
import { ToastProvider } from "@/components/ui-preset/toast"
import "../globals.css"
import { routing } from "@/i18n/routing"
import { cn } from "@/lib/utils"

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })

// 预渲染 zh / en 两套静态路由，页面内无需再逐个设置
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

// 按 locale 生成页面元信息（title/description）
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) return {}

  const t = await getTranslations({ locale, namespace: "metadata" })
  return {
    title: t("title"),
    description: t("description"),
  }
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode
  params: Promise<{ locale: string }>
}>) {
  const { locale } = await params
  const messages = await getMessages()

  return (
    <html
      lang={locale}
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable
      )}
    >
      <body>
        {/* 注入翻译消息与查询上下文，供客户端组件使用 useTranslations / useMutation */}
        <NextIntlClientProvider messages={messages}>
          <QueryProvider>
            <ToastProvider>{children}</ToastProvider>
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
