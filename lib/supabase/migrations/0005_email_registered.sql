-- WeatherMind：注册预检——邮箱是否已注册
-- 注册页「发送验证码」前先调本函数判断：已注册邮箱不再发验证码、直接提示。
-- 在 Supabase Dashboard → SQL Editor 执行（按 0001 → 0002 → 0003 → 0004 → 0005 顺序）
--
-- security definer + search_path 锁定 auth 前缀，防调用者注入；
-- lower() 归一化邮箱（Supabase 落库即小写）；deleted_at is null 排除已删除用户，允许其重新注册

create or replace function public.is_email_registered(p_email text)
returns boolean
language sql
security definer
set search_path = auth, public
as $$
  select exists (
    select 1 from auth.users
    where email = lower(p_email) and deleted_at is null
  );
$$;

-- 仅服务端 service_role 可调，避免匿名端枚举邮箱
revoke execute on function public.is_email_registered(text) from public;
grant  execute on function public.is_email_registered(text) to service_role;
