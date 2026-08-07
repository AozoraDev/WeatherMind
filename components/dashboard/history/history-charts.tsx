"use client"

import { Fragment, useId, useMemo, type ReactNode } from "react"
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Sun,
  ThermometerSnowflake,
  ThermometerSun,
  type LucideIcon,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  SOURCE_COLORS,
  WEATHER_SOURCES,
} from "@/components/ui-preset/weather-city-card"
import {
  conditionCategorySchema,
  type ConditionCategory,
  type WeatherSource,
} from "@/lib/schemas/weather"
import { cn, formatWeatherNumber } from "@/lib/utils"
import type { DailyRow } from "@/lib/weather/view-types"

// 合法归一分类集合：天气卡统计时跳过数据库里的非法值（口径与历史表格一致）
const VALID_CATEGORIES = new Set<string>(conditionCategorySchema.options)

// 与表格平台列 SOURCE_COLORS（text-*-600）同源的色值；
// Tailwind 文本类不能直接当 SVG stroke，这里转成等值 hex 供 Recharts 使用
const SOURCE_HEX: Record<WeatherSource, string> = {
  "open-meteo": "#059669", // emerald-600
  openweather: "#0284c7", // sky-600
  weatherapi: "#d97706", // amber-600
}

// 条件粗分类 → lucide 图标（天气卡/分布卡主角展示用）
const CONDITION_ICONS: Record<ConditionCategory, LucideIcon> = {
  clear: Sun,
  partlyCloudy: CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  rain: CloudRain,
  snow: CloudSnow,
  storm: CloudLightning,
  other: CloudDrizzle,
}

// 各天气分类的图标 chip 配色（浅色底 + 同色系前景，仅装饰身份，不做信息编码）
const CATEGORY_TINTS: Record<ConditionCategory, { text: string; bg: string }> =
  {
    clear: { text: "text-amber-500", bg: "bg-amber-50" },
    partlyCloudy: { text: "text-sky-500", bg: "bg-sky-50" },
    cloudy: { text: "text-slate-500", bg: "bg-slate-100" },
    fog: { text: "text-slate-400", bg: "bg-slate-50" },
    rain: { text: "text-blue-500", bg: "bg-blue-50" },
    snow: { text: "text-cyan-500", bg: "bg-cyan-50" },
    storm: { text: "text-violet-500", bg: "bg-violet-50" },
    other: { text: "text-emerald-500", bg: "bg-emerald-50" },
  }

// 折线图数据点：一天一行，6 列 = 3 源 × (最高/最低温)；某源当天缺数据则留空（断线）。
// bandLow / bandRange 为背景区间带：当日跨平台温度下界与「下界→上界」的高度
type TempPoint = {
  day: string
  "open-meteo-high": number
  "open-meteo-low": number
  "openweather-high": number
  "openweather-low": number
  "weatherapi-high": number
  "weatherapi-low": number
  bandLow: number
  bandRange: number
}

// 卡片顶部渐变饰条：负边距抵消 Card 自身内边距，使其贴住卡片上缘（与城市卡同一签名）
function AccentBar({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "-mx-(--card-spacing) -mt-(--card-spacing) h-1 bg-linear-to-r",
        className
      )}
    />
  )
}

// 顶部 KPI 小卡：彩色渐变图标章 + 指标名 + 大号数值，给历史页一个「数字先行」的层次
function StatTile({
  icon: Icon,
  chipClass,
  cardClass,
  label,
  value,
  sub,
}: {
  icon: LucideIcon
  chipClass: string
  cardClass: string
  label: string
  value: ReactNode
  sub?: string
}) {
  return (
    <Card className={cardClass}>
      <CardContent className="flex items-center gap-3">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br text-white shadow-sm",
            chipClass
          )}
        >
          <Icon aria-hidden="true" className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-xl leading-tight font-semibold">
            {value}
          </p>
          {sub ? (
            <p className="truncate text-xs text-muted-foreground">{sub}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

// 历史天气图表区：顶部 4 个 KPI 小卡（平均高/低温、累计降水、主导天气）+
// 温度趋势折线图（3 平台 × 最高/最低温 共 6 根线 + 跨平台区间带）、
// 逐日降水条形图、天气分布三条卡片；复用与表格相同的 DailyRow 数据，不新增查询
export function HistoryCharts({ rows }: { rows: DailyRow[] }) {
  const t = useTranslations("dashboard.history")
  const locale = useLocale()
  // 页面内 SVG 渐变 id 唯一化，避免与其它图表实例冲突
  const gradId = useId().replace(/:/g, "")

  // 本地时区短/长日期格式化器（用本地零点构造避免 new Date("YYYY-MM-DD") 按 UTC 偏移一天）
  const shortFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }),
    [locale]
  )
  const mediumFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale]
  )

  // 折线图配置：同源最高/最低温同色（色随平台），靠实线/虚线区分；图例标签由 i18n 拼装
  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {}
    for (const source of WEATHER_SOURCES) {
      const src = t(`sources.${source}`)
      config[`${source}-high`] = {
        label: `${src} · ${t("tempChart.high")}`,
        color: SOURCE_HEX[source],
      }
      config[`${source}-low`] = {
        label: `${src} · ${t("tempChart.low")}`,
        color: SOURCE_HEX[source],
      }
    }
    return config
  }, [t])

  // 每天一行，按天升序；缺源的列保持 undefined 让 Recharts 断线，
  // 同时按天聚合区间带（当日全部平台值的上下界）
  const tempPoints = useMemo(() => {
    type Acc = { point: Partial<TempPoint>; temps: number[] }
    const map = new Map<string, Acc>()
    for (const row of rows) {
      let acc = map.get(row.day)
      if (!acc) {
        acc = { point: { day: row.day }, temps: [] }
        map.set(row.day, acc)
      }
      acc.point[`${row.source}-high`] = row.high_temp
      acc.point[`${row.source}-low`] = row.low_temp
      acc.temps.push(row.high_temp, row.low_temp)
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { point, temps }]) => {
        const low = Math.min(...temps)
        const high = Math.max(...temps)
        // 区间高度 = 上界 - 下界，叠加在 bandLow 之上形成带，避免双轴
        return { ...point, bandLow: low, bandRange: high - low } as TempPoint
      })
  }, [rows])

  // Y 轴范围：全部最高/最低温取整后再上下各留 1°，避免曲线贴边
  const yDomain = useMemo<[number, number]>(() => {
    const vals = rows.flatMap((r) => [r.high_temp, r.low_temp])
    if (!vals.length) return [0, 1]
    return [Math.floor(Math.min(...vals) - 1), Math.ceil(Math.max(...vals) + 1)]
  }, [rows])

  // 平均最高/最低温：先按日取当日可用平台均值，再对全部天数取平均（口径与降水一致）
  const averages = useMemo(() => {
    const byDay = new Map<string, { high: number[]; low: number[] }>()
    for (const row of rows) {
      const acc = byDay.get(row.day) ?? { high: [], low: [] }
      acc.high.push(row.high_temp)
      acc.low.push(row.low_temp)
      byDay.set(row.day, acc)
    }
    const days = [...byDay.values()]
    if (!days.length) return { high: 0, low: 0 }
    const mean = (arr: number[]) =>
      arr.reduce((a, b) => a + b, 0) / (arr.length || 1)
    const high = days.reduce((s, d) => s + mean(d.high), 0) / days.length
    const low = days.reduce((s, d) => s + mean(d.low), 0) / days.length
    return { high, low }
  }, [rows])

  // 降水聚合：按日取当日可用平台的均值（与表格并列展示口径一致），再累加为区间总量；
  // 顺带记录降水峰值日，供条形图高亮与底部提示
  const precip = useMemo(() => {
    const byDay = new Map<string, number[]>()
    for (const row of rows) {
      const arr = byDay.get(row.day) ?? []
      arr.push(row.precipitation)
      byDay.set(row.day, arr)
    }
    const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
    const total = days.reduce(
      (sum, [, vals]) => sum + vals.reduce((a, b) => a + b, 0) / vals.length,
      0
    )
    const bars = days.map(([day, vals]) => {
      const [y, m, d] = day.split("-").map(Number)
      return {
        day,
        label: shortFmt.format(new Date(y, m - 1, d)),
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
      }
    })
    // 峰值日：纯函数找最大项索引，避免在渲染闭包内改 let 变量
    const peakIndex = bars.reduce(
      (best, bar, i, arr) => (bar.value > arr[best].value ? i : best),
      0
    )
    const peak = bars.length ? { ...bars[peakIndex], index: peakIndex } : null
    return { total, bars, peak }
  }, [rows, shortFmt])

  // 天气聚合：同一分类按天去重统计出现天数（避免同一天三平台重复计数），
  // 按天数降序；首项即主导天气，其余供分布卡逐行渲染
  const weather = useMemo(() => {
    const byCatDay = new Map<ConditionCategory, Set<string>>()
    for (const row of rows) {
      const cat = row.condition_category as ConditionCategory | null
      if (!cat || !VALID_CATEGORIES.has(cat)) continue
      const set = byCatDay.get(cat) ?? new Set<string>()
      set.add(row.day)
      byCatDay.set(cat, set)
    }
    const entries = [...byCatDay.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .map(([cat, set]) => ({ cat, days: set.size }))
    return { entries, dominant: entries[0] ?? null }
  }, [rows])

  const shortDay = (day: string) => {
    const [y, m, d] = day.split("-").map(Number)
    return shortFmt.format(new Date(y, m - 1, d))
  }
  // tooltip label 是 ReactNode，按字符串解析日期；解析失败原样回退
  const mediumDay = (label: unknown) => {
    const day = String(label)
    const [y, m, d] = day.split("-").map(Number)
    if (!y || !m || !d) return day
    return mediumFmt.format(new Date(y, m - 1, d))
  }

  const DominantIcon = weather.dominant
    ? CONDITION_ICONS[weather.dominant.cat]
    : null

  return (
    <div className="flex flex-col gap-6">
      {/* 顶部 KPI 行：数字先行，给单调的纯图表区一个层次入口 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          icon={ThermometerSun}
          chipClass="from-amber-400 to-orange-500"
          cardClass="bg-linear-to-br from-amber-50/70 via-white to-orange-50/40"
          label={t("stats.avgHigh")}
          value={<>{formatWeatherNumber(averages.high)}°C</>}
        />
        <StatTile
          icon={ThermometerSnowflake}
          chipClass="from-sky-400 to-blue-500"
          cardClass="bg-linear-to-br from-sky-50/70 via-white to-blue-50/40"
          label={t("stats.avgLow")}
          value={<>{formatWeatherNumber(averages.low)}°C</>}
        />
        <StatTile
          icon={Droplets}
          chipClass="from-cyan-400 to-sky-500"
          cardClass="bg-linear-to-br from-cyan-50/70 via-white to-sky-50/40"
          label={t("precipChart.title")}
          value={
            <>
              {formatWeatherNumber(precip.total)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {t("precipChart.unit")}
              </span>
            </>
          }
        />
        <StatTile
          icon={DominantIcon ?? CloudDrizzle}
          chipClass="from-indigo-400 to-violet-500"
          cardClass="bg-linear-to-br from-indigo-50/70 via-white to-violet-50/40"
          label={t("stats.dominant")}
          value={
            weather.dominant ? t(`categories.${weather.dominant.cat}`) : "—"
          }
          sub={
            weather.dominant
              ? t("weatherChart.days", { count: weather.dominant.days })
              : t("noData")
          }
        />
      </div>

      {/* 主图区：左 2/3 温度趋势 + 右列逐日降水/天气分布 */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* 左：温度趋势折线图（主视觉区） */}
        <Card className="lg:col-span-2">
          <AccentBar className="from-sky-400 to-blue-500" />
          <CardHeader>
            <CardTitle>{t("tempChart.title")}</CardTitle>
            <CardDescription>{t("tempChart.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {/* 浅色渐变底增强视觉纵深，不参与数据编码 */}
            <ChartContainer
              config={chartConfig}
              className="aspect-auto h-72 bg-linear-to-b from-sky-50/80 via-sky-50/40 to-transparent"
            >
              <LineChart
                data={tempPoints}
                margin={{ left: 0, right: 12, top: 8, bottom: 0 }}
              >
                <defs>
                  {/* 区间带渐变：上端（高温）微泛蓝，向低温端渐隐 */}
                  <linearGradient
                    id={`tempBand-${gradId}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.18} />
                    <stop
                      offset="100%"
                      stopColor="#2563eb"
                      stopOpacity={0.04}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={shortDay}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={40}
                  domain={yDomain}
                  tickFormatter={(v) => `${v}°`}
                />
                <ChartTooltip
                  cursor={{ stroke: "#94a3b8", strokeWidth: 1 }}
                  content={
                    <ChartTooltipContent
                      indicator="dot"
                      labelFormatter={mediumDay}
                      formatter={(value) =>
                        `${formatWeatherNumber(Number(value))}°C`
                      }
                    />
                  }
                />
                {/* 跨平台区间带：带随曲线绘制，仅作氛围底衬 */}
                <Area
                  dataKey="bandLow"
                  stackId="band"
                  stroke="none"
                  fill="none"
                  dot={false}
                  activeDot={false}
                  tooltipType="none"
                  isAnimationActive={false}
                />
                <Area
                  dataKey="bandRange"
                  stackId="band"
                  stroke="none"
                  fill={`url(#tempBand-${gradId})`}
                  dot={false}
                  activeDot={false}
                  tooltipType="none"
                  isAnimationActive={false}
                />
                {WEATHER_SOURCES.map((source) => (
                  <Fragment key={source}>
                    <Line
                      dataKey={`${source}-high`}
                      type="monotone"
                      stroke={`var(--color-${source}-high)`}
                      strokeWidth={2}
                      strokeLinecap="round"
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                    <Line
                      dataKey={`${source}-low`}
                      type="monotone"
                      stroke={`var(--color-${source}-low)`}
                      strokeWidth={2}
                      strokeDasharray="5 5"
                      strokeLinecap="round"
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </Fragment>
                ))}
              </LineChart>
            </ChartContainer>

            {/* 图例：三平台圆点 + 线型语义说明；高/低温区分靠线型，不靠颜色（颜色只代表平台） */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-4">
                {WEATHER_SOURCES.map((source) => (
                  <span
                    key={source}
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-medium",
                      SOURCE_COLORS[source]
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-current"
                    />
                    {t(`sources.${source}`)}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("tempChart.legendHint")}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* 右列：逐日降水（上）+ 天气分布（下），上下堆叠并撑满左列高度 */}
        <div className="flex flex-col gap-6">
          <Card>
            <AccentBar className="from-cyan-400 to-sky-500" />
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Droplets aria-hidden="true" className="size-4 text-sky-600" />
                {t("precipChart.title")}
              </CardTitle>
              <CardDescription>{t("precipChart.desc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={{
                  value: {
                    label: t("precipChart.title"),
                    color: "#0ea5e9",
                  },
                }}
                className="aspect-auto h-32"
              >
                <BarChart
                  data={precip.bars}
                  margin={{ top: 18, left: 0, right: 0, bottom: 0 }}
                >
                  <defs>
                    {/* 常规条与峰值条两档渐变：峰值用更深一档强调（同一蓝色系） */}
                    <linearGradient
                      id={`precipBar-${gradId}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#38bdf8" />
                      <stop offset="100%" stopColor="#2563eb" />
                    </linearGradient>
                    <linearGradient
                      id={`precipBarPeak-${gradId}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#2563eb" />
                      <stop offset="100%" stopColor="#4338ca" />
                    </linearGradient>
                  </defs>
                  <ChartTooltip
                    cursor={{ fill: "rgb(226 232 240 / 0.4)" }}
                    content={
                      <ChartTooltipContent
                        indicator="dot"
                        labelKey="label"
                        labelFormatter={(_value, payload) => {
                          const first = payload?.[0] as
                            { payload?: { day?: string } } | undefined
                          return first?.payload?.day
                            ? mediumDay(first.payload.day)
                            : ""
                        }}
                        formatter={(value) =>
                          `${formatWeatherNumber(Number(value))} mm`
                        }
                      />
                    }
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={24}>
                    {precip.bars.map((bar, index) => (
                      <Cell
                        key={bar.day}
                        fill={
                          precip.peak?.index === index
                            ? `url(#precipBarPeak-${gradId})`
                            : `url(#precipBar-${gradId})`
                        }
                      />
                    ))}
                    <LabelList
                      position="top"
                      fontSize={11}
                      className="fill-muted-foreground"
                      valueAccessor={(_, index) =>
                        precip.peak?.index === index
                          ? formatWeatherNumber(precip.peak.value)
                          : null
                      }
                    />
                  </Bar>
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                  />
                </BarChart>
              </ChartContainer>

              {/* 峰值日提示：只标最湿一天，不逐点注数 */}
              {precip.peak && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-sky-600"
                  />
                  {t("precipChart.peak", {
                    day: mediumDay(precip.peak.day),
                    value: formatWeatherNumber(precip.peak.value),
                  })}
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="flex-1">
            <AccentBar className="from-indigo-400 to-violet-500" />
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CloudSun
                  aria-hidden="true"
                  className="size-4 text-indigo-500"
                />
                {t("weatherChart.title")}
              </CardTitle>
              <CardDescription>{t("weatherChart.desc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {weather.entries.length > 0 ? (
                <ul className="flex flex-col gap-3">
                  {weather.entries.map(({ cat, days }) => {
                    const Icon = CONDITION_ICONS[cat]
                    const tint = CATEGORY_TINTS[cat]
                    // 比例条宽度 = 出现天数 / 最多天数，真实反映量级
                    const pct = Math.round(
                      (days / weather.entries[0].days) * 100
                    )
                    return (
                      <li key={cat} className="flex items-center gap-3">
                        <span
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-lg",
                            tint.bg,
                            tint.text
                          )}
                        >
                          <Icon aria-hidden="true" className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-sm font-medium">
                              {t(`categories.${cat}`)}
                            </span>
                            <span className="text-sm font-semibold tabular-nums">
                              {days}
                              {t("weatherChart.dayUnit")}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-linear-to-r from-sky-400 to-indigo-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t("noData")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
