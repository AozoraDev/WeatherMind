-- WeatherMind Phase 2 每日天气快照表
-- 历史天气二级页数据源：每 城×源 每天一行，按城市本地日归日（city.timezone）
-- 在 Supabase Dashboard → SQL Editor 执行
-- 说明：沿用 Phase 1 决策，RLS 保持关闭（proxy.ts 统一鉴权）；
--       「覆盖当日」由 upsert 冲突键 (city_id, source, day) 保证，7 天窗口由 pipeline 清理维护

create table if not exists public.weather_daily (
  id                 uuid primary key default gen_random_uuid(),
  city_id            uuid not null references public.cities(id) on delete cascade,
  source             text not null check (source in ('open-meteo','openweather','weatherapi')),
  day                date not null,               -- 城市本地日期（按 city.timezone 归日，YYYY-MM-DD）
  high_temp          double precision not null,   -- 当日最高温 °C（当日预报 slot 取最大值）
  low_temp           double precision not null,   -- 当日最低温 °C（当日预报 slot 取最小值）
  temperature        double precision not null,   -- 采集时刻的实时温度快照 °C
  precipitation      double precision not null default 0, -- 当日降水累计 mm（slot 求和）
  condition_code     integer,                     -- 当日最高温 slot 的条件码（保留源值）
  condition_label    text,                        -- 当日最高温 slot 的条件文案（保留源值）
  condition_category text,                        -- 当日最高温 slot 的归一粗分类
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (city_id, source, day)                   -- 覆盖当日：upsert 冲突键
);

-- 查询与清理索引：按 城×日期 排序取近 7 天、按 城×日期 边界删除过期
create index if not exists idx_daily_city_day on public.weather_daily (city_id, day desc);
