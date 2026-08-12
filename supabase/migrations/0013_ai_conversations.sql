-- WeatherMind AI 助手对话：每个用户自己的对话记录
-- 在 Supabase Dashboard → SQL Editor 执行（按 0001 → 0013 顺序）
-- 说明：按 user_id 隔离——RLS 只放行 auth.uid() 自己的行；写入（建/删/存消息）
--       走 service_role 绕过 RLS，service 客户端在 server action / chat 路由里带 user_id 过滤。
--       messages 是 jsonb 数组 [{role:"user"|"assistant", content, created_at}]，
--       由 chat 路由在信任边界 safeParse 后读改写；updated_at 无触发器，写时手动置 now。
--       title 默认空串，首条用户消息由 chat 路由截断填充；空标题客户端本地化回退。

create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                        -- 不建 FK（惯例不引用 auth.users），按它过滤 + 索引兜底
  title text not null default '',
  messages jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 侧栏会话列表按 用户×最近更新 排序
create index if not exists idx_ai_conversations_user_updated
  on public.ai_conversations (user_id, updated_at desc);

-- RLS：登录用户只读自己的会话；增删改不开放，仅供 service_role 绕过（沿用 0003/0006 风格）
alter table public.ai_conversations enable row level security;
drop policy if exists "authenticated_select_ai_conversations"
  on public.ai_conversations;
create policy "authenticated_select_ai_conversations"
  on public.ai_conversations for select to authenticated using (auth.uid() = user_id);
