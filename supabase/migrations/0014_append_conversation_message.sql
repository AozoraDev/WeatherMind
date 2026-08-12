-- WeatherMind AI 助手：对话消息原子追加
-- 在 Supabase Dashboard → SQL Editor 执行（按 0001 → 0014 顺序）
-- 说明：ai_conversations.messages 是 jsonb 数组。chat 路由原先「读 messages → 拼新 →
--       整段写回」，多标签页并发会互相覆盖丢消息。改为 DB 内单条 UPDATE 原子追加
--       （messages || jsonb_build_array），行级锁保证并发下不丢；返回追加后的权威数组，
--       路由据此构建提示词，无需再整段读回。
--       首条用户消息（jsonb_array_length=0）时用 p_title 填 title（路由按码点截断后传入），
--       其余不动 title。
-- 安全：security invoker（非 definer）→ 函数体以调用者权限执行，受表 RLS 约束；
--       表上无 UPDATE 的 RLS 策略 → 客户端直连 RPC 会被拒绝；路由经 service_role
--       （BYPASSRLS）调用绕过 RLS，owner 校验由 where user_id 承担。最后显式收紧执行权，
--       仅 service_role 可调用，双重保险。
create or replace function public.append_conversation_message(
  p_conversation_id uuid,
  p_user_id uuid,
  p_message jsonb,
  p_title text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_new_messages jsonb;
begin
  update public.ai_conversations
  set messages = messages || jsonb_build_array(p_message),
      title = case
        when jsonb_array_length(messages) = 0 and p_title is not null then p_title
        else title
      end,
      updated_at = now()
  where id = p_conversation_id and user_id = p_user_id
  returning messages into v_new_messages;

  if not found then
    return null;  -- 行不存在或非本人：调用方据此回 404
  end if;
  return v_new_messages;
end;
$$;

-- 执行权收紧：anon/authenticated 不可直接调，仅 service_role（服务端受信路径）可调
revoke execute on function public.append_conversation_message(uuid, uuid, jsonb, text) from public;
grant execute on function public.append_conversation_message(uuid, uuid, jsonb, text) to service_role;
