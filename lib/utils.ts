import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 天气数值统一展示口径：从数据库取出的天气数据（温度/降水/风速/湿度等）默认保留一位小数，
// 各展示点共用，避免各处 toFixed 出现「累计降水 0.0 但表格 0.02」这类口径不一致。
// 非零但一位小数会显示成 0.0 的微量值（|value| < 0.05，如 0.02mm 降水）降级保留两位小数，
// 避免把真实微量数据抹成 0 与柱状图产生「显示 0 但有柱子」的矛盾。经纬度属地理坐标，不在此列
export function formatWeatherNumber(value: number): string {
  const one = value.toFixed(1)
  // 一位小数已四舍五入成 0.0 时，若非零微量则补一位精度还原真实值
  if ((one === "0.0" || one === "-0.0") && value !== 0) return value.toFixed(2)
  return one
}
