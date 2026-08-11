-- WeatherMind ForecastAgent：预测按语言各自生成/缓存。
-- AI 解读文案在生成时用当时 locale 定稿（读时不转译），故 city×day×locale 唯一：
-- 中文界面读中文那条，英文界面读英文那条，切换语言自然看到对应语言解读。
-- 在 Supabase Dashboard → SQL Editor 执行（0006 之后）。

-- 加 locale 列：已有行默认归 zh
alter table public.forecast_agent_predictions
  add column if not exists locale text not null default 'zh' check (locale in ('zh','en'));

-- 旧唯一键（城×日）改（城×日×语言）；先删旧约束再建新约束（约束不幂等，需可重复执行）
alter table public.forecast_agent_predictions
  drop constraint if exists forecast_agent_predictions_city_id_day_key;
alter table public.forecast_agent_predictions
  add constraint forecast_agent_predictions_city_id_day_locale_key unique (city_id, day, locale);
