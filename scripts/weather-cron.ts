// GitHub Actions 每日采集入口：直连 Supabase 跑天气管道并落库，不经部署环境。
// 与旧 /api/cron/weather 的区别：路由恒 200（失败也「绿但没执行」），
// 这里按运行终态退出——全失败（succeeded=0）退出非零让工作流标红，便于第一时间发现。
import { runWeatherPipeline } from "@/lib/weather/pipeline"

async function main() {
  const summary = await runWeatherPipeline("cron")
  // 完整摘要打日志，Actions 日志里直接看各格成败与落库 runId
  console.log(JSON.stringify(summary, null, 2))

  // 部分成功仍算已执行（保持绿色），只有整轮零成功才判失败；
  // 管道自身恒不抛错，缺 env（如 service_role key）时 createServiceClient 抛错，由 tsx 退出非零
  if (summary.status === "failed") process.exit(1)
}

main()
