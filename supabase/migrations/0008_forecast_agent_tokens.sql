-- WeatherMind ForecastAgent：记录 AI 生成消耗的 token，报告底部展示用量。
-- 只在成功行写入（usage 由 OpenAI 兼容接口标准计费字段透传）；部分代理不回传时保持 null。
-- 在 Supabase Dashboard → SQL Editor 执行（0007 之后）。
-- 说明：total = prompt + completion，故只存两列、展示时求和，不冗余。

alter table public.forecast_agent_predictions
  add column if not exists prompt_tokens integer,     -- AI 生成输入 token
  add column if not exists completion_tokens integer; -- AI 生成输出 token
