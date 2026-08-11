-- WeatherMind ForecastAgent：当日城市预测（数学集成引擎 + AI 解读）
-- 在 Supabase Dashboard → SQL Editor 执行（按 0001 → 0005 → 0006 顺序）
-- 说明：写一次读多次——forecast_agent_predictions 按 城×日 唯一，
--       首个用户点击认领生成（status=pending→success/failed），其后任何人只读库；
--       failed 行允许同天重试（核心逻辑见 lib/forecast-agent/core.ts 的 failed 转 pending）；
--       weather_truth 存历史参考真值（三源 history 接口的中位数），供权重回测校准。
--       RLS 沿用 0003：authenticated 只读，写入仅 service_role 绕过。

create table if not exists public.forecast_agent_predictions (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id) on delete cascade,
  day date not null,                              -- 城市本地日 YYYY-MM-DD
  status text not null check (status in ('pending','success','failed')),
  -- 确定性内核输出（模板指标）
  predicted_high double precision,                -- 加权集成预测高温 °C
  predicted_low double precision,                 -- 加权集成预测低温 °C
  high_interval jsonb,                            -- [低, 高] 预测区间
  low_interval jsonb,
  precipitation_probability double precision,     -- 降水概率 0-100（报雨源权重和）
  precip_level text,                              -- none/light/moderate/heavy
  condition text,                                 -- 加权多数投票的 conditionCategory
  wind_beaufort int,                              -- 蒲福风级
  wind_speed double precision,                    -- 加权平均风速 m/s
  humidity double precision,                      -- 加权平均湿度 %
  confidence text check (confidence in ('high','medium','low')),
  risk_flags jsonb not null default '[]',         -- [{type, level, sources}]
  -- 快照：审计/可复现演算过程
  weights jsonb not null default '{}',            -- 各源权重快照
  source_inputs jsonb not null default '{}',      -- 各源输入快照（高/低/降水/条件/湿度/风）
  formula_version text,                           -- 指标公式版本
  -- AI 解读文案
  summary text,
  points jsonb,                                   -- [{metricId, text}]
  advice text,
  model text,                                     -- 生成所用模型
  error_code text,                                -- 失败原因（受限码）
  created_by text,                                -- 触发者邮箱（配额/审计）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (city_id, day)                           -- 写一次读多次冲突键
);

-- 查询与清理索引：按 城×日 排序取当天预测
create index if not exists idx_forecast_agent_city_day
  on public.forecast_agent_predictions (city_id, day desc);

create table if not exists public.weather_truth (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id) on delete cascade,
  day date not null,                              -- 城市本地日 YYYY-MM-DD
  observed_high double precision not null,        -- 三源 history 中位数（参考真值）
  observed_low double precision not null,
  observed_precip double precision not null default 0,
  sources_used int not null default 1,            -- 实际参与中位数的源数
  created_at timestamptz not null default now(),
  unique (city_id, day)
);

create index if not exists idx_truth_city_day on public.weather_truth (city_id, day desc);

-- RLS：登录用户可读全表；增删写不开放，仅供 service_role 绕过（沿用 0003）
-- drop policy if exists：SQL Editor 手动重复执行时幂等（create policy 不幂等会报 42710）
alter table public.forecast_agent_predictions enable row level security;
alter table public.weather_truth                  enable row level security;
drop policy if exists "authenticated_select_forecast_agent_predictions"
  on public.forecast_agent_predictions;
create policy "authenticated_select_forecast_agent_predictions"
  on public.forecast_agent_predictions for select to authenticated using (true);
drop policy if exists "authenticated_select_weather_truth"
  on public.weather_truth;
create policy "authenticated_select_weather_truth"
  on public.weather_truth for select to authenticated using (true);
