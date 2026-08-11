-- WeatherMind ForecastAgent：ReAct 推理轨迹（Thought/Action/Observation）落库，卡片折叠区展示。
-- 只在成功行写入；模型一步直出（无工具调用）时为空数组，卡上折叠区隐藏。
-- 在 Supabase Dashboard → SQL Editor 执行（0008 之后）。

alter table public.forecast_agent_predictions
  add column if not exists react_trace jsonb; -- ReAct 推理轨迹（thought/actions 步骤数组）
