-- 预报 Agent 新增纯 Markdown 输出列：AI 流式输出 ## 推理过程 + ## 预报 全文存此列。
-- 旧结构化列（summary/points/advice）新行不再写入，旧行此列为 null，前端兜底渲染。
alter table public.forecast_agent_predictions
  add column if not exists markdown_body text;
