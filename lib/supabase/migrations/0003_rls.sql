-- WeatherMind Phase 3 启用 Row Level Security
-- 读取走 authenticated 角色（proxy.ts 中间件 + dashboard layout 已保证登录态）；
-- 写入只经 service_role（bypass RLS）：cron 管道（lib/weather/pipeline.ts）与
-- 城市增删（lib/weather/city-actions.ts）均切换为 service client。
-- 在 Supabase Dashboard → SQL Editor 执行（按 0001 → 0002 → 0003 顺序）

alter table public.cities           enable row level security;
alter table public.weather_current  enable row level security;
alter table public.weather_runs     enable row level security;
alter table public.weather_daily    enable row level security;

-- 只读策略：登录用户可读全表；增删写不开放，仅供 service_role 绕过
create policy "authenticated_select_cities"           on public.cities           for select to authenticated using (true);
create policy "authenticated_select_weather_current"  on public.weather_current  for select to authenticated using (true);
create policy "authenticated_select_weather_runs"     on public.weather_runs     for select to authenticated using (true);
create policy "authenticated_select_weather_daily"    on public.weather_daily    for select to authenticated using (true);
