-- WeatherMind Phase 1 天气数据表
-- 在 Supabase Dashboard → SQL Editor 执行
-- 说明：本阶段明确关闭 RLS（见文末注释），由 proxy.ts 中间件统一鉴权

create table if not exists public.cities (
  id          uuid primary key default gen_random_uuid(),
  name_ja     text not null,
  name_en     text not null,
  latitude    double precision not null,
  longitude   double precision not null,
  timezone    text not null default 'Asia/Tokyo',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (name_en)
);

-- 实时天气：每 城×源 只保留一行最新值，upsert 用 (city_id, source)
create table if not exists public.weather_current (
  id                 uuid primary key default gen_random_uuid(),
  city_id            uuid not null references public.cities(id) on delete cascade,
  source             text not null check (source in ('open-meteo','openweather','weatherapi')),
  observed_at        timestamptz not null,            -- 源观测时刻（UTC）
  temperature        double precision not null,        -- °C
  feels_like         double precision,                 -- °C
  humidity           double precision,                 -- %
  pressure           double precision,                 -- hPa
  wind_speed         double precision not null,        -- m/s
  wind_direction     double precision,                 -- 气象角度
  precipitation      double precision not null default 0, -- mm
  condition_code     integer,
  condition_label    text,
  condition_category text,
  raw                jsonb,                            -- 源响应全文（调试用）
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (city_id, source)
);

-- 采集运行记录：pipeline 先插 running，结束后更新为终态与计数
create table if not exists public.weather_runs (
  id               uuid primary key default gen_random_uuid(),
  status           text not null check (status in ('running','success','partial','failed')),
  trigger          text not null check (trigger in ('manual','cron')),
  total_cells      integer not null default 0,         -- 城×源 总数
  succeeded_cells  integer not null default 0,
  failed_cells     integer not null default 0,
  error            text,                               -- 首个错误摘要
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);

-- 查询索引
create index if not exists idx_current_city_source  on public.weather_current (city_id, source, updated_at desc);
create index if not exists idx_runs_started         on public.weather_runs (started_at desc);

-- 日本主要城市种子数据（真实经纬度，全部 Asia/Tokyo，无夏令时）
insert into public.cities (name_ja, name_en, latitude, longitude, timezone) values
  ('東京',   'Tokyo',     35.6762, 139.6503, 'Asia/Tokyo'),
  ('大阪',   'Osaka',     34.6937, 135.5023, 'Asia/Tokyo'),
  ('名古屋', 'Nagoya',    35.1815, 136.9066, 'Asia/Tokyo'),
  ('福岡',   'Fukuoka',   33.5904, 130.4017, 'Asia/Tokyo'),
  ('札幌',   'Sapporo',   43.0618, 141.3545, 'Asia/Tokyo'),
  ('仙台',   'Sendai',    38.2682, 140.8694, 'Asia/Tokyo'),
  ('広島',   'Hiroshima', 34.3853, 132.4553, 'Asia/Tokyo'),
  ('那覇',   'Naha',      26.2124, 127.6809, 'Asia/Tokyo')
on conflict (name_en) do nothing;

-- RLS 决策：本阶段保持 RLS 关闭（仪表盘由 proxy.ts 中间件统一鉴权、
-- cron 走 anon key）；启用 RLS 见后续 0003_rls.sql，届时写入统一切 service_role 绕过。
