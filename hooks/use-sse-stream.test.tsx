import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ModelConfig } from "@/lib/model-config"
import {
  useSseStream,
  type UseSseStreamOptions,
} from "./use-sse-stream"

// 传输层 hook 的组件级回归测试：重点验证「流正常关闭但没收到终态事件」时状态归 error，
// 不再永久卡在 streaming（问题 1）。fetch 用 ReadableStream 桩模拟 SSE 响应

type TestEvent = { type: "done" }
type TestError = "network" | "generic"
type TestArgs = { prompt: string }

const MODEL: ModelConfig = {
  baseUrl: "https://api.example.com",
  apiKey: "sk",
  model: "gpt",
  models: ["gpt"],
}

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (body) controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return {
    ok: true,
    body: stream,
    headers: new Headers(),
  } as unknown as Response
}

function makeOpts(
  onError?: (code: TestError) => void
): UseSseStreamOptions<TestArgs, TestError, TestEvent> {
  return {
    url: "/api/test",
    model: MODEL,
    buildBody: (params) => ({ prompt: params.prompt }),
    onTransportError: "network",
    onNoBodyError: "generic",
    onParseError: "generic",
    decodeError: () => "generic",
    onEvent: (ev, ctx) => {
      if (ev.type === "done") ctx.markDone()
    },
    onError,
  }
}

const mockFetch = vi.fn()

function renderHost(opts: UseSseStreamOptions<TestArgs, TestError, TestEvent>) {
  const api: {
    current: ReturnType<typeof useSseStream<TestArgs, TestError, TestEvent>>
  } = { current: null as never }
  function Host() {
    api.current = useSseStream(opts)
    return (
      <div>
        <output>{api.current.status}</output>
        <button onClick={() => api.current.start({ prompt: "hi" })}>start</button>
      </div>
    )
  }
  render(<Host />)
  return api
}

describe("useSseStream", () => {
  afterEach(() => {
    cleanup() // vitest 未开 globals，RTL 不自动清理，需手动卸载上次渲染的组件
    mockFetch.mockReset()
    vi.unstubAllGlobals()
  })

  it("流正常关闭但无终态事件 → 状态归 error（不永久卡 streaming）", async () => {
    const user = userEvent.setup()
    const onError = vi.fn()
    mockFetch.mockResolvedValue(sseResponse("")) // 空流：read 立即 done，无 done/error 帧
    vi.stubGlobal("fetch", mockFetch)
    const api = renderHost(makeOpts(onError))
    await user.click(screen.getByRole("button", { name: "start" }))
    await screen.findByText("error")
    expect(api.current.status).toBe("error")
    expect(api.current.errorCode).toBe("network")
    expect(onError).toHaveBeenCalledWith("network")
  })

  it("收到 done 终态事件 → 状态 done，不误判 error", async () => {
    const user = userEvent.setup()
    mockFetch.mockResolvedValue(sseResponse('data: {"type":"done"}\n\n'))
    vi.stubGlobal("fetch", mockFetch)
    const api = renderHost(makeOpts())
    await user.click(screen.getByRole("button", { name: "start" }))
    await screen.findByText("done")
    expect(api.current.status).toBe("done")
    expect(api.current.errorCode).toBeNull()
  })
})
