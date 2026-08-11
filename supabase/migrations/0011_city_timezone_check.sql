-- 时区不变量：预报 Agent 的权重窗口 / 配额日界 / 真值轮换均按 Asia/Tokyo 硬编码
-- （lib/forecast-agent/engine/weights.ts 的 toJstDateKey、quota.ts 的日界、
-- engine/truth.ts 的 pruneOldTruth），而 weather_daily.day / weather_truth.day
-- 按 city.timezone 归日——一旦出现非东京时区城市，该城行会被窗口静默漏算、真值被误轮换。
-- 此 CHECK 把「全城 Asia/Tokyo」的假设变成硬约束，防未来新增城市时误用其他时区。
-- 在 Supabase Dashboard → SQL Editor 执行（0010 之后）。
alter table public.cities
  drop constraint if exists cities_timezone_tokyo_check;
alter table public.cities
  add constraint cities_timezone_tokyo_check check (timezone = 'Asia/Tokyo');
