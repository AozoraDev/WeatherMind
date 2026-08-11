"use client"

import { RefreshCw, Sparkles } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useRef, type CSSProperties } from "react"

import { ButtonBlue, ButtonGreen } from "@/components/ui-preset/button"
import {
  WeatherCityCard,
  WEATHER_SOURCES,
} from "@/components/ui-preset/weather-city-card"
import { useToast } from "@/components/ui-preset/toast"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ForecastAgentCard } from "@/components/dashboard/forecast/forecast-agent-card"
import { ForecastReasoningCard } from "@/components/dashboard/forecast/forecast-reasoning-card"
import { useRouter } from "@/i18n/navigation"
import { refreshWeatherAction } from "@/lib/weather/actions"
import { useElementHeight } from "@/hooks/use-element-height"
import { useForecastStream } from "@/hooks/use-forecast-stream"
import type { ForecastAgentErrorCode } from "@/lib/forecast-agent/common/errors"
import { WeatherError } from "@/lib/weather/errors"
import {
  conditionCategorySchema,
  type WeatherSource,
} from "@/lib/schemas/weather"
import type { CityRow, CurrentRow, RunRow } from "@/lib/weather/view-types"
import { useModelConfig } from "@/hooks/use-model-config"

// 预报页视图：服务端已按 ?city= 解析出唯一城市，这里展示该城三源当前天气卡片 + 手动刷新（仅管理员）+ 最近运行状态；
// 下拉切换城市即导航到新 ?city= 的预报页，由服务端重取该城数据。
// 「预报当日」按钮对所有已登录用户可见：配置了 AI 模型才可点击（否则 Tooltip 提示）。
// 点击后走 useForecastStream → POST /api/ai-agent/forecast 的 SSE 流：tool 事件实时呈现
// ReAct 工具调用过程（右侧推理卡），delta 逐字流式渲染 Markdown 正文，完成后落库回读；
// 二次点击直接 duplicate 展示既有行。

const AGENT_ERROR_KEYS = new Set<ForecastAgentErrorCode>([
  "no-model",
  "retry-cooldown",
  "insufficient-data",
  "provider",
  "parse",
  "consistency",
  "react-loop",
  "generic",
])

export function ForecastView({
  cities,
  selectedCityId,
  currents,
  latestRun,
  isAdmin,
  email,
}: {
  cities: CityRow[]
  selectedCityId: string
  currents: CurrentRow[]
  latestRun: RunRow | null
  isAdmin: boolean
  email: string
}) {
  const t = useTranslations("dashboard.forecast")
  const locale = useLocale()
  const router = useRouter()
  const toast = useToast()
  const modelConfig = useModelConfig(email)

  // 左列城市卡实测高度：右列推理卡按它限高，保证两卡等高、推理内容超出时在卡内滚动
  const { ref: leftCardRef, height: leftCardHeight } =
    useElementHeight<HTMLDivElement>()

  // 流式状态：cityId/locale/model 变化自动经 argsRef 生效；切换城市由下方 effect 调 reset 清场
  const stream = useForecastStream({
    cityId: selectedCityId,
    locale: locale as "zh" | "en",
    model: modelConfig,
    onDone: (row) => {
      // 城市切换后旧流仍会 resolve：只采纳当前城市的结果，防跨城串行
      if (row.city_id !== selectedCityId) return
      if (row.status === "success") toast.success(t("refreshSuccess"))
    },
    onError: (code) => {
      toast.error(
        AGENT_ERROR_KEYS.has(code)
          ? t(`forecastAgent.error.${code}`)
          : t("forecastAgent.error.generic")
      )
    },
  })

  // 切换城市 = 导航到带新 ?city= 的预报页，服务端按参数重取单城数据
  const handleCityChange = (cityId: string) => {
    const city = cities.find((c) => c.id === cityId)
    if (city) {
      router.push(
        { pathname: "/dashboard/forecast", query: { city: city.name_en } },
        { scroll: false }
      )
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await refreshWeatherAction()
      if (!res.ok) throw new WeatherError(res.error)
      return res.summary
    },
    onSuccess: () => {
      toast.success(t("refreshSuccess"))
      // 重拉服务端数据，刷新卡片与最近运行
      router.refresh()
    },
    onError: (e) => {
      toast.error(
        e instanceof WeatherError ? t(`errors.${e.code}`) : t("errors.generic")
      )
    },
  })

  // 城市切换 = 导航到新 ?city= 页，组件不重挂载；这里用 effect 中断在途流并清空流式状态，
  // 避免残留上一城市的半成品/错误（副作用必须进 effect）
  // 城市切换 = 导航到新 ?city= 页，组件不重挂载；这里用 effect 中断在途流并清空流式状态，
  // 避免残留上一城市的半成品/错误（副作用必须进 effect）。reset 是 useCallback 稳定函数，
  // 抽成局部引用后放依赖数组不会因每次渲染重跑（stream 对象本身每次渲染都是新引用）
  const resetStream = stream.reset
  const prevCityRef = useRef(selectedCityId)
  useEffect(() => {
    if (prevCityRef.current === selectedCityId) return
    prevCityRef.current = selectedCityId
    resetStream()
  }, [selectedCityId, resetStream])

  // 按 城×源 取最近一条当前天气（表中每 城×源 只有一行，这里防御性去重）
  const latestByCell = new Map<string, CurrentRow>()
  for (const row of currents) {
    const key = `${row.city_id}:${row.source}`
    if (!latestByCell.has(key)) latestByCell.set(key, row)
  }

  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Tokyo",
    }).format(new Date(iso))

  // 各平台名文案一次性注入卡片预设
  const sourceLabels = Object.fromEntries(
    WEATHER_SOURCES.map((s) => [s, t(`sources.${s}`)])
  ) as Record<WeatherSource, string>

  // 归一分类 → 本地化文案：当前天气卡状态列按当前语言显示（与历史页 categories 同值）
  const conditionLabels = Object.fromEntries(
    conditionCategorySchema.options.map((c) => [
      c,
      t(`forecastAgent.condition.${c}`),
    ])
  ) as Record<string, string>

  // 城市 id → 展示名映射，供 SelectValue 渲染选中项标签
  const cityLabels = Object.fromEntries(
    cities.map((city) => [city.id, `${city.name_ja} · ${city.name_en}`])
  )

  // 选中城市的各源最新数据；缺源时卡片内部会逐源兜底显示「暂无数据」
  const selectedCity = cities.find((c) => c.id === selectedCityId)
  const cells = selectedCity
    ? (Object.fromEntries(
        WEATHER_SOURCES.map((s) => [
          s,
          latestByCell.get(`${selectedCity.id}:${s}`) ?? null,
        ])
      ) as Record<WeatherSource, CurrentRow | null>)
    : null

  return (
    <div className="flex flex-col gap-6">
      {cities.length === 0 || latestByCell.size === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-muted-foreground">{t("empty")}</p>
          {isAdmin && (
            <ButtonBlue
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? t("refreshing") : t("refresh")}
            </ButtonBlue>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">
                {t("selectCity")}
              </span>
              <Select
                value={selectedCityId}
                onValueChange={(v) => v && handleCityChange(String(v))}
                items={cityLabels}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cities.map((city) => (
                    <SelectItem key={city.id} value={city.id}>
                      {city.name_ja} · {city.name_en}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="ml-auto flex items-center gap-4">
              {latestRun ? (
                <p className="text-sm text-muted-foreground">
                  {t("lastUpdated", { time: formatTime(latestRun.started_at) })}
                  <span className="ml-2 text-foreground">
                    {t(`status.${latestRun.status}`)}
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              )}
              {isAdmin && (
                <ButtonBlue
                  size="sm"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate()}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={mutation.isPending ? "animate-spin" : ""}
                  />
                  {mutation.isPending ? t("refreshing") : t("refresh")}
                </ButtonBlue>
              )}
              {/* 预报当日：所有已登录用户可见；未配置 AI 模型时禁用并用 Tooltip 提示 */}
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  <ButtonGreen
                    size="sm"
                    disabled={
                      !modelConfig || stream.state.status === "streaming"
                    }
                    onClick={() => stream.start()}
                  >
                    <Sparkles
                      aria-hidden="true"
                      className={
                        stream.state.status === "streaming"
                          ? "animate-pulse"
                          : ""
                      }
                    />
                    {stream.state.status === "streaming"
                      ? t("forecastAgent.generating")
                      : t("forecastAgent.generate")}
                  </ButtonGreen>
                </TooltipTrigger>
                <TooltipContent>
                  {modelConfig
                    ? t("forecastAgent.generateTooltip")
                    : t("forecastAgent.noModelTooltip")}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {selectedCity && cells && (
            <>
              {/* 顶部一行：城市三源卡固定左列，AI 推理过程卡在右列（ReAct 工具调用轨迹）。
                  items-stretch 让右列撑满行高，--left-height 是左卡实测高度、右卡按它限高；
                  左列 self-start 防止被更高行拉伸，保证测到的是城市卡自身自然高度 */}
              <div
                className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-stretch"
                style={
                  {
                    "--left-height": leftCardHeight
                      ? `${leftCardHeight}px`
                      : undefined,
                  } as CSSProperties
                }
              >
                <div ref={leftCardRef} className="max-w-xl lg:self-start">
                  <WeatherCityCard
                    key={selectedCity.id}
                    city={selectedCity}
                    cells={cells}
                    sourceLabels={sourceLabels}
                    conditionLabels={conditionLabels}
                    humidityLabel={t("fields.humidity")}
                    windLabel={t("fields.wind")}
                    noDataLabel={t("noData")}
                  />
                </div>

                {/* 推理过程卡：流式渲染 ReAct 工具调用（thought/action/observation），错误时灰显半成品；
                    限高随左卡变化，内容超出时卡内滚动 */}
                <div className="min-w-0 lg:max-h-(--left-height)">
                  <ForecastReasoningCard
                    row={stream.state.row}
                    stream={stream.state}
                  />
                </div>
              </div>

              {/* ForecastAgent 结果卡片：全宽，流式渲染 AI Markdown 正文（## 推理过程 + ## 预报） */}
              <ForecastAgentCard
                city={selectedCity}
                row={stream.state.row}
                stream={stream.state}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
