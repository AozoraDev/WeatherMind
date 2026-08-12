import { beforeEach, describe, expect, it, vi } from "vitest"

import { computeWeights } from "../engine/weights"
import {
  runSupervisedStream,
  type AgentId,
  type AgentTraceStep,
  type OrchestratorStreamEvent,
} from "@/lib/agent-core/orchestrator"
import {
  runForecastAgentStream,
  type ForecastAgentStreamEvent,
} from "./stream"
import { CITY, CURRENT_TWO, DAILY_TWO, MODEL, PARAMS, fakeSupabase } from "../common/test-utils"

vi.mock("@/lib/agent-core/orchestrator", () => ({ runSupervisedStream: vi.fn() }))
vi.mock("../engine/weights", () => ({ computeWeights: vi.fn() }))

const mockedSupervised = vi.mocked(runSupervisedStream)
const mockedWeights = vi.mocked(computeWeights)

beforeEach(() => {
  mockedSupervised.mockReset()
  mockedWeights.mockReset()
  mockedWeights.mockResolvedValue({
    "open-meteo": 0.5,
    openweather: 0.3,
    weatherapi: 0.2,
  } as never)
})

// 多 agent 编排 mock：主管先委托两位专家（reconcile/risk），再逐 delta 产出最终 Markdown。
// 事件全部带 agentId（编排层契约），供 stream 逐事件透传断言
function supervisedSuccess(opts: {
  content: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
  trace?: AgentTraceStep[]
}): AsyncGenerator<OrchestratorStreamEvent> {
  const usage = opts.usage ?? { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  const trace = opts.trace ?? []
  return (async function* () {
    yield { type: "agent_start", agentId: "supervisor" }
    yield { type: "thought", agentId: "supervisor", text: "先核对 openweather" }
    yield { type: "rollback", agentId: "supervisor", chars: "先核对 openweather".length }
    yield { type: "agent_start", agentId: "reconcile" }
    yield {
      type: "tool",
      agentId: "reconcile",
      name: "query_source",
      args: '{"source":"openweather"}',
      result: '{"high":31.2}',
    }
    yield { type: "agent_end", agentId: "reconcile", ok: true }
    yield {
      type: "tool",
      agentId: "supervisor",
      name: "delegate_reconcile",
      args: "{}",
      result: "核对结论：各源一致",
    }
    yield { type: "agent_start", agentId: "risk" }
    yield { type: "agent_end", agentId: "risk", ok: true }
    yield {
      type: "tool",
      agentId: "supervisor",
      name: "delegate_risk",
      args: "{}",
      result: "风险解读：高温注意",
    }
    yield { type: "delta", agentId: "supervisor", text: "## 推理过程\n" }
    yield { type: "delta", agentId: "supervisor", text: opts.content.slice("## 推理过程\n".length) }
    yield { type: "result", result: { ok: true, content: opts.content, usage, trace } }
  })()
}

describe("runForecastAgentStream", () => {
  // 合法 Markdown 文档：两段齐 + high/low 落在集成结果（30.4/22.4）容差内 + poP=0 允许无 %
  // 确定性集成（DAILY_TWO + 权重 0.5/0.3/0.2）→ high≈30.4、low≈22.4、poP=0
  const VALID_MD = `## 推理过程
本次预报基于 open-meteo 与 openweather 两源的确定性集成计算。两源均报晴且无降水，加权集成后预测高温约 30°C、低温约 22°C，体感舒适。
## 预报
今日天气晴朗，预测高温 30°C，低温 22°C，降水概率很低，无需担心降水。`

  // 消费异步生成器，收集全部事件
  async function consumeStream(
    gen: AsyncGenerator<ForecastAgentStreamEvent>
  ): Promise<ForecastAgentStreamEvent[]> {
    const events: ForecastAgentStreamEvent[] = []
    for await (const ev of gen) events.push(ev)
    return events
  }

  it("已存在 success 行 → duplicate，不触发 AI", async () => {
    const existing = {
      id: "old",
      status: "success" as const,
      day: "2026-08-09",
    }
    const handler = async (table: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "forecast_agent_predictions")
        return { data: existing, error: null }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events).toContainEqual({ type: "duplicate", row: existing })
    expect(mockedSupervised).not.toHaveBeenCalled()
  })

  it("认领冲突（他人 pending 行）→ duplicate 其行", async () => {
    let predSelects = 0
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert") return { data: null, error: { code: "23505" } }
        if (first === "select") {
          predSelects++
          // 首次回读为空（走认领）→ 冲突后读回他人 pending 行
          return predSelects === 1
            ? { data: null, error: null }
            : {
                data: { id: "theirs", status: "pending" as const },
                error: null,
              }
        }
        return {
          data: { id: "theirs", status: "pending" as const },
          error: null,
        }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events).toContainEqual({
      type: "duplicate",
      row: { id: "theirs", status: "pending" },
    })
    expect(mockedSupervised).not.toHaveBeenCalled()
  })

  it("失败冷却期内（failed_at 距今 <5 分钟）→ retry-cooldown，不认领、不触发 AI", async () => {
    // failed 行失败于 1 分钟前：仍在 5 分钟冷却窗口内
    const existing = {
      id: "old",
      status: "failed" as const,
      failed_at: new Date(Date.now() - 60_000).toISOString(),
      day: "2026-08-09",
    }
    const handler = async (table: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "forecast_agent_predictions")
        return { data: existing, error: null }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events).toContainEqual({ type: "error", code: "retry-cooldown" })
    expect(mockedSupervised).not.toHaveBeenCalled()
    // 未走到认领：不插入新行
    expect(
      service.calls.filter((c) => c.method === "insert")
    ).toHaveLength(0)
  })

  it("失败冷却已过（failed_at 距今 ≥5 分钟）→ 走认领重试", async () => {
    // failed 行失败于 10 分钟前：已出冷却窗口，可认领重试（claimPending 转回 pending）
    const existing = {
      id: "old",
      status: "failed" as const,
      failed_at: new Date(Date.now() - 600_000).toISOString(),
      day: "2026-08-09",
    }
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert") return { data: null, error: { code: "23505" } }
        if (first === "update")
          return { data: { id: "old", status: "pending" as const }, error: null }
        return { data: existing, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    // 已过冷却 → 不被 retry-cooldown 拦截，进入认领重试（首个 update 即 failed→pending 转换）
    expect(events).not.toContainEqual({ type: "error", code: "retry-cooldown" })
    const firstUpdate = service.calls.find(
      (c) => c.method === "update"
    )?.args[0] as Record<string, unknown>
    expect(firstUpdate).toMatchObject({
      status: "pending",
      error_code: null,
      failed_at: null,
    })
  })

  it("当日源不足（<2 源）→ 落 failed+failed_at + insufficient-data", async () => {
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") {
        return {
          data: [
            {
              source: "open-meteo",
              high_temp: 30,
              low_temp: 22,
              precipitation: 0,
              condition_category: "clear",
            },
          ],
          error: null,
        }
      }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "update") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events.at(-1)).toEqual({ type: "error", code: "insufficient-data" })
    expect(mockedSupervised).not.toHaveBeenCalled()
    // 失败落库：settle 为 failed + failed_at（供冷却计时），不再删除
    const update = service.calls.find(
      (c) => c.method === "update"
    )?.args[0] as Record<string, unknown>
    expect(update).toMatchObject({
      status: "failed",
      error_code: "insufficient-data",
    })
    expect(typeof update.failed_at).toBe("string")
    expect(
      service.calls.filter((c) => c.method === "delete")
    ).toHaveLength(0)
  })

  it("全链路：认领 → 集成 → 多 agent 编排（agent_start/tool/delta）→ 校验 → settle 含 markdown_body → done", async () => {
    const TRACE = [
      {
        thought: "先核对 openweather",
        actions: [{ name: "query_source", args: "{}", result: "{}" }],
        agent_id: "reconcile",
      },
      {
        thought: "委托专家",
        actions: [{ name: "delegate_risk", args: "{}", result: "风险解读：高温注意" }],
        agent_id: "supervisor",
      },
    ]
    mockedSupervised.mockImplementation(() =>
      supervisedSuccess({ content: VALID_MD, trace: TRACE })
    )

    let claimedRow: Record<string, unknown> | null = null
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert") {
          claimedRow = { id: "row-1", status: "pending" as const }
          return { data: claimedRow, error: null }
        }
        if (first === "update") {
          claimedRow = { ...claimedRow, status: "success" as const }
          return { data: null, error: null }
        }
        return { data: claimedRow, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )

    // 阶段序列：start → read → claim → ensemble → agent → validate → settle
    const phases = events
      .filter(
        (e): e is Extract<ForecastAgentStreamEvent, { type: "status" }> =>
          e.type === "status"
      )
      .map((e) => e.phase)
    expect(phases).toEqual([
      "start",
      "read",
      "claim",
      "ensemble",
      "agent",
      "validate",
      "settle",
    ])

    // 多 agent 边界事件透传：agent_start/agent_end 原样转发，带 agentId
    expect(events).toContainEqual({ type: "agent_start", agentId: "supervisor" })
    expect(events).toContainEqual({ type: "agent_start", agentId: "reconcile" })
    expect(events).toContainEqual({ type: "agent_start", agentId: "risk" })
    expect(events).toContainEqual({ type: "agent_end", agentId: "reconcile", ok: true })

    // thought/rollback/tool 带 agentId 透传
    expect(events).toContainEqual({
      type: "thought",
      agentId: "supervisor",
      text: "先核对 openweather",
    })
    expect(events).toContainEqual({
      type: "rollback",
      agentId: "supervisor",
      chars: "先核对 openweather".length,
    })
    expect(events).toContainEqual({
      type: "tool",
      agentId: "reconcile",
      name: "query_source",
      args: '{"source":"openweather"}',
      result: '{"high":31.2}',
    })
    expect(events).toContainEqual({
      type: "tool",
      agentId: "supervisor",
      name: "delegate_reconcile",
      args: "{}",
      result: "核对结论：各源一致",
    })

    // 只有主管的 delta 拼接后等于全文（专家 delta/rollback 已由编排层丢弃，此处不出现）
    const allDelta = events
      .filter(
        (e): e is { type: "delta"; text: string; agentId: AgentId } =>
          e.type === "delta"
      )
      .map((e) => e.text)
      .join("")
    expect(allDelta).toBe(VALID_MD)

    // settle patch 含 markdown_body 全文 + 含 agent_id 的全局轨迹（纯 Markdown 输出契约落库）
    const patch = service.calls.find((c) => c.method === "update")
      ?.args[0] as Record<string, unknown>
    expect(patch).toMatchObject({
      status: "success",
      markdown_body: VALID_MD,
      model: MODEL.model,
      predicted_high: expect.any(Number),
      predicted_low: expect.any(Number),
      react_trace: TRACE,
      error_code: null,
      // usage 落库（杀 ?? null 被 && null 兜掉的突变）
      prompt_tokens: 11,
      completion_tokens: 7,
    })
    // 透传给编排层的模型参数与 usage 读取自 loopResult（杀对象字面量 {} 突变）
    expect(mockedSupervised.mock.calls[0][0].model).toEqual(MODEL)
    // 专家团注册传入编排层：主管 + 两位专家（顺序固定）
    const call = mockedSupervised.mock.calls[0][0]
    expect(call.supervisor.agentId).toBe("supervisor")
    expect(call.specialists.map((s) => s.agentId)).toEqual(["reconcile", "risk"])

    // done 事件带 success 行
    const done = events.find(
      (e): e is Extract<ForecastAgentStreamEvent, { type: "done" }> =>
        e.type === "done"
    )
    expect(done?.row.status).toBe("success")
  })

  it("校验不过（AI 胡编高温 40°C）→ 回滚 + consistency", async () => {
    const BAD_MD = `## 推理过程
基于两源确定性集成计算，加权平均得到预测高温与低温，两源均报晴且无降水，天气稳定。
## 预报
今日预测高温 40°C，低温 22°C，降水概率很低。`
    mockedSupervised.mockImplementation(() =>
      supervisedSuccess({ content: BAD_MD })
    )
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "update") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events.at(-1)).toEqual({ type: "error", code: "consistency" })
    // 失败落库：settle 为 failed + failed_at，不再删除
    const update = service.calls.find(
      (c) => c.method === "update"
    )?.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: "failed", error_code: "consistency" })
    expect(typeof update.failed_at).toBe("string")
    expect(
      service.calls.filter((c) => c.method === "delete")
    ).toHaveLength(0)
  })

  it("编排 provider 错 → 落 failed+failed_at + provider", async () => {
    mockedSupervised.mockImplementation(async function* (): AsyncGenerator<OrchestratorStreamEvent> {
      yield { type: "result", result: { ok: false, error: "network" } }
    })
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "update") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events.at(-1)).toEqual({ type: "error", code: "provider" })
    const update = service.calls.find(
      (c) => c.method === "update"
    )?.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: "failed", error_code: "provider" })
    expect(typeof update.failed_at).toBe("string")
  })

  it("编排步数耗尽 → 落 failed+failed_at + react-loop", async () => {
    mockedSupervised.mockImplementation(async function* (): AsyncGenerator<OrchestratorStreamEvent> {
      yield { type: "result", result: { ok: false, error: "react-loop" } }
    })
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "update") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events.at(-1)).toEqual({ type: "error", code: "react-loop" })
    const update = service.calls.find(
      (c) => c.method === "update"
    )?.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: "failed", error_code: "react-loop" })
    expect(typeof update.failed_at).toBe("string")
  })

  it("settle 成功落库失败 → rollback 删除 pending 行并报 generic", async () => {
    mockedSupervised.mockImplementation(() =>
      supervisedSuccess({ content: VALID_MD })
    )
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "update")
          return { data: null, error: { message: "db down" } }
        if (first === "delete") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events.at(-1)).toEqual({ type: "error", code: "generic" })
    // rollback 兜底删除未落库的 pending 行
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "delete",
      args: [],
    })
  })

  it("集成阶段未预期异常 → generic 兜底 + finally 清理", async () => {
    // computeWeights 抛错：走外层 catch → error generic
    mockedWeights.mockRejectedValue(new Error("boom"))
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "delete") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events.at(-1)).toEqual({ type: "error", code: "generic" })
    expect(mockedSupervised).not.toHaveBeenCalled()
    // 已认领但未落库 → finally 删除 pending 行
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "delete",
      args: [],
    })
  })

  it("客户端断开且清理删除失败 → 兜底 settle 为 failed", async () => {
    mockedSupervised.mockImplementation(() =>
      supervisedSuccess({ content: VALID_MD })
    )
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "delete")
          return { data: null, error: { message: "fk" } }
        if (first === "update") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const gen = runForecastAgentStream(
      session as never,
      service as never,
      PARAMS
    )
    let sawDelta = false
    for (let i = 0; i < 20 && !sawDelta; i++) {
      const { value } = await gen.next()
      if (value?.type === "delta") sawDelta = true
    }
    expect(sawDelta).toBe(true)
    await gen.return(undefined)

    // 删除失败 → settleRow 改为 failed（可重试），而非卡死 pending
    const update = service.calls.find(
      (c) => c.method === "update"
    )?.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: "failed", error_code: "generic" })
  })

  it("城市不存在 → generic", async () => {
    const session = fakeSupabase(async () => ({ data: null, error: null }))
    const service = fakeSupabase(async () => ({ data: null, error: null }))

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events).toEqual([
      { type: "status", phase: "start" },
      { type: "error", code: "generic" },
    ])
  })

  it("城市查询参数：cities 表 / select * / eq id / is_active true", async () => {
    // 当日按城市时区定日的前提是查出活跃城市；断言查询参数杀表名/列名/布尔突变
    const handler = async (table: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "forecast_agent_predictions")
        return { data: null, error: null }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)
    await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(session.calls).toContainEqual({
      table: "cities",
      method: "select",
      args: ["*"],
    })
    expect(session.calls).toContainEqual({
      table: "cities",
      method: "eq",
      args: ["id", "city-1"],
    })
    expect(session.calls).toContainEqual({
      table: "cities",
      method: "eq",
      args: ["is_active", true],
    })
  })

  it("调用前已断开（signal.aborted）→ 不发起任何查询/生成，直接 generic", async () => {
    const session = fakeSupabase(async () => ({ data: null, error: null }))
    const service = fakeSupabase(async () => ({ data: null, error: null }))
    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, {
        ...PARAMS,
        signal: { aborted: true } as unknown as AbortSignal,
      })
    )
    expect(events).toEqual([{ type: "error", code: "generic" }])
    expect(mockedSupervised).not.toHaveBeenCalled()
    // 断线即止，不碰城市表
    expect(session.calls.filter((c) => c.table === "cities")).toHaveLength(0)
  })

  it("客户端断开（生成器被 return）→ finally 兜底删除未落库的 pending 行", async () => {
    mockedSupervised.mockImplementation(() =>
      supervisedSuccess({ content: VALID_MD })
    )
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "delete") return { data: null, error: null }
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const gen = runForecastAgentStream(
      session as never,
      service as never,
      PARAMS
    )
    // 推进到 agent 阶段的 delta，确认已认领（pending 行在库）
    let sawDelta = false
    for (let i = 0; i < 20 && !sawDelta; i++) {
      const { value } = await gen.next()
      if (value?.type === "delta") sawDelta = true
    }
    expect(sawDelta).toBe(true)

    // 客户端断开：对生成器 return()，触发 finally 兜底清理
    await gen.return(undefined)

    // pending 行被删除；未走 success settle（无 update）
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "delete",
      args: [],
    })
    expect(service.calls).toContainEqual({
      table: "forecast_agent_predictions",
      method: "eq",
      args: ["id", "row-1"],
    })
    expect(service.calls.some((c) => c.method === "update")).toBe(false)
  })

  it("settle 成功但回读失败 → 不删除成功行，仅报 generic", async () => {
    mockedSupervised.mockImplementation(() =>
      supervisedSuccess({ content: VALID_MD })
    )
    const handler = async (table: string, first: string) => {
      if (table === "cities") return { data: CITY, error: null }
      if (table === "weather_daily") return { data: DAILY_TWO, error: null }
      if (table === "weather_current") return { data: CURRENT_TWO, error: null }
      if (table === "forecast_agent_predictions") {
        if (first === "insert")
          return { data: { id: "row-1", status: "pending" }, error: null }
        if (first === "update") return { data: null, error: null }
        // select 一律 null：认领前读不到、settle 后回读也失败
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const session = fakeSupabase(handler)
    const service = fakeSupabase(handler)

    const events = await consumeStream(
      runForecastAgentStream(session as never, service as never, PARAMS)
    )
    expect(events.at(-1)).toEqual({ type: "error", code: "generic" })
    // 关键：成功行不得被回滚删除
    expect(service.calls.filter((c) => c.method === "delete")).toHaveLength(0)
  })
})
