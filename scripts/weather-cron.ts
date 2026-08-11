// GitHub Actions 每日采集入口：直连 Supabase 跑天气管道并落库，不经部署环境。
// 与旧 /api/cron/weather 的区别：路由恒 200（失败也「绿但没执行」），
// 这里按运行终态退出——全失败（succeeded=0）退出非零让工作流标红，便于第一时间发现。
import { runWeatherPipeline } from "@/lib/weather/pipeline"
import { createServiceClient } from "@/supabase/service"
import { backfillTruth } from "@/lib/forecast-agent/engine/truth"
import { clearPredictions } from "@/lib/forecast-agent/db/db"

async function main() {
  const summary = await runWeatherPipeline("cron")
  // 完整摘要打日志，Actions 日志里直接看各格成败与落库 runId
  console.log(JSON.stringify(summary, null, 2))

  // 每日清空预测表：预测按 城×日×语言 累积，跨日数据对当天无意义，故每天整表清空重来
  // （见 lib/forecast-agent/db/db.ts 的 clearPredictions）。
  // 尽力而为：失败仅记录日志，不影响采集主流程与运行终态，次日运行自愈
  try {
    const cleared = await clearPredictions(createServiceClient())
    console.log(
      cleared ? "预测表已清空" : "预测表清理失败（将于下一次运行重试）"
    )
  } catch (e) {
    console.error("预测表清理失败（将于下一次运行重试）", e)
  }

  // 参考真值回填：拉「昨天」各源历史观测，取三源中位数落 weather_truth，
  // 供 ForecastAgent 权重随真值天数逐步校准（见 lib/forecast-agent/weights.ts）。
  // 尽力而为：失败仅记录日志，不影响采集主流程与运行终态，次日运行自愈
  try {
    const truth = await backfillTruth(createServiceClient())
    console.log(`参考真值回填完成：${truth.cities} 城 / ${truth.rows} 行`)
  } catch (e) {
    console.error("参考真值回填失败（将于下一次运行重试）", e)
  }

  // 部分成功仍算已执行（保持绿色），只有整轮零成功才判失败；
  // 管道自身恒不抛错，缺 env（如 service_role key）时 createServiceClient 抛错，由 tsx 退出非零
  if (summary.status === "failed") process.exit(1)
}

main()
