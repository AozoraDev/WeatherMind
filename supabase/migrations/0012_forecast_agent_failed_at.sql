-- ForecastAgent 失败冷却：failed 行记录失败时刻，冷却期内（5 分钟）禁止重试同一 城×日×语言。
-- 替代原「每日 10 次」配额（已随 quota 模块删除）：正常使用不限次数，只挡失败重试刷服务器。
alter table public.forecast_agent_predictions
  add column if not exists failed_at timestamptz; -- 最近一次失败时刻（null=未失败/成功行）
