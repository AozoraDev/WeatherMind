-- WeatherMind：删除逐小时 weather_forecast 表
-- 历史天气由 weather_daily（城×源×天 一行）统一承载，逐小时原始预报表无页面读取
-- 已在旧库执行过 0001 时在 Supabase Dashboard → SQL Editor 执行；全新库无需执行
-- 索引与 RLS 策略随表一并自动删除
drop table if exists public.weather_forecast;
