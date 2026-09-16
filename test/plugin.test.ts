import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { homedir } from "node:os"
import type { Plugin } from "@opencode/plugin"
import plugin, { DiscordNotificationPlugin } from "../src/index"

type Event = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never
type Session = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type Messages = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
type Models = Awaited<ReturnType<Plugin.Context["model"]["list"]>>
const webhookUrl = "https://discord.invalid/api/webhooks/test/token"
const config = { enabled: true, webhookUrl, username: "Test Notifier", avatarUrl: "https://example.com/avatar.png" }
const location = { directory: `${homedir()}/project` }
const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } }
const permission: Event = {
  id: "event-permission",
  created: 1,
  type: "permission.asked",
  data: {
    id: "permission-1",
    sessionID: "session-1",
    action: "shell",
    message: "Run a command?",
    resources: ["git status", "git diff"],
  },
}
const question: Extract<Event, { type: "form.created" }> = {
  id: "event-question",
  created: 1,
  type: "form.created",
  data: {
    form: {
      id: "form-1",
      sessionID: "session-1",
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "message-1", id: "call-1" } },
      fields: [
        {
          key: "q0",
          type: "string",
          title: "Publish",
          description: "Which version?",
          options: [{ value: "v2", label: "v2", description: "Use v2" }],
          custom: true,
        },
        {
          key: "q1",
          type: "multiselect",
          description: "Which checks?",
          options: [{ value: "tests", label: "Tests" }],
          custom: true,
        },
      ],
    },
  },
}
const completed: Event = {
  id: "event-completed",
  created: 1,
  type: "session.execution.succeeded",
  durable: { aggregateID: "session-1", seq: 1, version: 1 },
  data: { sessionID: "session-1" },
}
const cleanups: Plugin.Cleanup[] = []
let session: Session
let messages: Messages
let models: Models
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

interface Payload {
  username: string
  avatar_url?: string
  allowed_mentions: { parse: string[] }
  embeds: {
    title: string
    description: string
    color: number
    fields: { name: string; value: string; inline: boolean }[]
    footer: { text: string }
  }[]
}

function payload(index = 0): Payload {
  return JSON.parse(String(fetchSpy.mock.calls[index]?.[1]?.body))
}

// Each send resolves when the consumer has finished handling that event.
function harness(options: Record<string, unknown> = config, owner: Session["location"] = location) {
  let writer: ReadableStreamDefaultController<{ event: Event; done: () => void }>
  const stream = new ReadableStream<{ event: Event; done: () => void }>({
    start(controller) {
      writer = controller
    },
  })
  const get = mock(async () => session)
  const context = mock(async () => messages)
  const list = mock(async () => models)
  let closed = false
  const subscribe = mock(async function* (options?: { signal?: AbortSignal }) {
    const reader = stream.getReader()
    const abort = () => {
      void reader.cancel()
    }
    options?.signal?.addEventListener("abort", abort, { once: true })
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        try {
          yield item.value.event
        } finally {
          item.value.done()
        }
      }
    } finally {
      closed = true
      options?.signal?.removeEventListener("abort", abort)
      reader.releaseLock()
    }
  })
  const ctx = {
    options,
    location: owner,
    event: { subscribe },
    session: { get, context },
    model: { list },
  } as unknown as Plugin.Context
  const start = plugin.setup(ctx)
  const cleanup = async () => {
    const dispose = await start
    await dispose?.()
  }
  cleanups.push(cleanup)
  return {
    get,
    context,
    list,
    subscribe,
    cleanup,
    get closed() {
      return closed
    },
    send(event: Event) {
      if (subscribe.mock.calls.length === 0) return Promise.resolve()
      return new Promise<void>((done) => writer.enqueue({ event, done }))
    },
  }
}

beforeEach(() => {
  session = {
    id: "session-1",
    projectID: "project-1",
    title: "My session",
    location,
    tokens,
    cost: 0,
    time: { created: 1, updated: 2 },
  }
  messages = []
  models = { location, data: [] }
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
})

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  mock.restore()
})

describe("v2 notifications", () => {
  test("exports a stable v2 definition", () => {
    expect(plugin).toBe(DiscordNotificationPlugin)
    expect(plugin.id).toBe("opencode-discord-noti")
    expect(typeof plugin.setup).toBe("function")
  })

  test("sends pending permission details using v2 fields", async () => {
    const instance = harness()
    await instance.send(permission)
    expect(instance.get).toHaveBeenCalledWith({ sessionID: "session-1" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(webhookUrl)
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST")
    const body = payload()
    expect(body.username).toBe(config.username)
    expect(body.avatar_url).toBe(config.avatarUrl)
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.embeds[0]?.description).toBe("Run a command?")
    expect(body.embeds[0]?.color).toBe(0xffa500)
    expect(body.embeds[0]?.fields).toContainEqual({ name: "📁 Directory", value: "~/project", inline: true })
    expect(body.embeds[0]?.fields).toContainEqual({ name: "🔒 Type", value: "shell", inline: true })
    expect(body.embeds[0]?.fields).toContainEqual({
      name: "🎯 Resources",
      value: "```\ngit status, git diff\n```",
      inline: false,
    })
  })

  test("formats question forms and tool metadata", async () => {
    await harness().send(question)
    expect(payload().embeds[0]?.description).toContain("Which version?")
    expect(payload().embeds[0]?.description).toContain("• **v2** — Use v2")
    expect(payload().embeds[0]?.description).toContain("Which checks?")
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "🆔 Call ID", value: "call-1", inline: true })
  })

  test("ignores unrelated forms, replies, execution failures and legacy idle events", async () => {
    const instance = harness()
    await instance.send({ ...question, data: { form: { ...question.data.form, metadata: {} } } })
    await instance.send({
      id: "reply",
      created: 1,
      type: "permission.replied",
      data: { sessionID: "session-1", requestID: "permission-1", reply: "reject" },
    })
    await instance.send({
      ...completed,
      type: "session.execution.failed",
      data: { sessionID: "session-1", error: { type: "error", message: "Failed" } },
    })
    await instance.send({ id: "idle", created: 1, type: "session.idle", data: { sessionID: "session-1" } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(instance.get).not.toHaveBeenCalled()
  })

  test.each([
    {},
    { enabled: false, webhookUrl },
    { enabled: true },
    { webhookUrl },
    { enabled: "true", webhookUrl },
    { enabled: true, webhookUrl: 123 },
    { enabled: true, webhookUrl: "  " },
  ])("disabled or invalid options do not subscribe: %j", async (options) => {
    const instance = harness(options)
    expect(instance.subscribe).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("captures options without mutating them and isolates instances", async () => {
    const options = { ...config, webhookUrl: ` ${webhookUrl} ` }
    const first = harness(options)
    expect(options.webhookUrl).toBe(` ${webhookUrl} `)
    options.webhookUrl = "https://discord.invalid/changed"
    const second = harness({ ...config, webhookUrl: "https://discord.invalid/second" })
    await first.send(permission)
    await second.send(permission)
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([webhookUrl, "https://discord.invalid/second"])
  })

  test("uses default optional settings", async () => {
    await harness({ enabled: true, webhookUrl, username: 123, avatarUrl: false }).send(permission)
    expect(payload().username).toBe("OpenCode Notifier")
    expect(payload()).not.toHaveProperty("avatar_url")
  })

  test("filters global events by directory, resolving unlocated sessions", async () => {
    const instances = [harness(), harness(config, { directory: "/other" })]
    for (const event of [permission, { ...question, location }]) {
      await Promise.all(instances.map((instance) => instance.send(event)))
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(instances[1]?.get).toHaveBeenCalledTimes(1)
  })

  test("ignores global forms even with question metadata", async () => {
    const instance = harness()
    await instance.send({ ...question, data: { form: { ...question.data.form, sessionID: "global" } } })
    expect(instance.get).not.toHaveBeenCalled()
  })

  test("bounds long descriptions and session fields", async () => {
    session.title = "x".repeat(2000)
    await harness().send({
      ...question,
      data: { form: { ...question.data.form, fields: [{ type: "string", key: "q0", description: "q".repeat(5000) }] } },
    })
    expect(payload().embeds[0]?.description.length).toBe(1500)
    expect(payload().embeds[0]?.fields[0]?.value.length).toBe(1024)
  })

  test("failed lookups are contained and the subscription continues", async () => {
    const instance = harness()
    instance.get.mockRejectedValueOnce(new Error("offline"))
    const log = spyOn(console, "error").mockImplementation(() => {})
    await instance.send(permission)
    await instance.send(question)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
  })

  test.each(["network", "http"])("%s failures are contained without logging webhook secrets", async (kind) => {
    if (kind === "network") fetchSpy.mockRejectedValueOnce(new Error(`Request failed: ${webhookUrl}`))
    else fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
    const log = spyOn(console, "error").mockImplementation(() => {})
    const instance = harness()
    await instance.send(permission)
    await instance.send(question)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(webhookUrl)
  })

  test("completion includes only final text, native session totals and latest context usage", async () => {
    const assistant = {
      id: "assistant-1",
      type: "assistant" as const,
      agent: "build",
      model: { id: "test-model", providerID: "test" },
      time: { created: 1, completed: 2 },
      tokens,
      content: [{ type: "text" as const, text: "Earlier" }],
    }
    messages = [
      { ...assistant, tokens: { ...tokens, input: 900 } },
      {
        ...assistant,
        id: "assistant-2",
        content: [
          { type: "reasoning", text: "Hidden" },
          { type: "text", text: "Done!" },
          { type: "text", text: "Verified." },
        ],
      },
      { ...assistant, id: "unfinished", time: { created: 3 }, content: [{ type: "text", text: "Incomplete" }] },
    ]
    models.data = [{ id: "test-model", providerID: "test", limit: { context: 1000 } } as Models["data"][number]]
    session.tokens = { ...tokens, input: 1000 }
    await harness().send(completed)
    const embed = payload().embeds[0]!
    expect(embed.description).toBe("Done!\nVerified.")
    expect(embed.color).toBe(0x00ff00)
    expect(embed.fields).toContainEqual({ name: "📊 Context Usage", value: "16.50%", inline: true })
    expect(embed.fields).toContainEqual({ name: "🔢 Session Tokens", value: "1,065 tokens", inline: true })
    expect(embed.fields).toContainEqual({ name: "🤖 Model", value: "test/test-model", inline: true })
    expect(embed.footer.text).toBe("Session ID: session-1")
  })

  test("subagent idle and completion never notify or fetch message history", async () => {
    session.parentID = "parent-1"
    const instance = harness()
    await instance.send({ id: "idle", created: 1, type: "session.idle", data: { sessionID: "session-1" } })
    await instance.send(completed)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(instance.context).not.toHaveBeenCalled()
    expect(instance.list).not.toHaveBeenCalled()
  })

  test("context usage does not reuse pre-compaction usage or reset cumulative session tokens", async () => {
    messages = [
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: { id: "test-model", providerID: "test" },
        time: { created: 1, completed: 2 },
        tokens,
        content: [{ type: "text", text: "Done!" }],
      },
      {
        id: "compaction",
        type: "compaction",
        status: "completed",
        reason: "auto",
        time: { created: 3 },
        summary: "Summary",
        recent: "assistant",
      },
    ]
    const instance = harness()
    await instance.send(completed)
    expect(instance.list).not.toHaveBeenCalled()
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "📊 Context Usage", value: "N/A", inline: true })
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "🔢 Session Tokens", value: "165 tokens", inline: true })
  })

  test("subagent permissions and questions still request attention", async () => {
    session.parentID = "parent-1"
    const instance = harness()
    await instance.send(permission)
    await instance.send(question)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  test("completion tolerates empty context and missing model metadata", async () => {
    await harness().send(completed)
    expect(payload().embeds[0]?.description).toBe("Response completed.")
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "📊 Context Usage", value: "N/A", inline: true })
  })

  test("model list failure does not suppress completion", async () => {
    messages = [
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "test" },
        time: { created: 1, completed: 2 },
        tokens,
        content: [{ type: "text", text: "Done!" }],
      },
    ]
    const instance = harness()
    instance.list.mockRejectedValueOnce(new Error("offline"))
    await instance.send(completed)
    expect(payload().embeds[0]?.description).toBe("Done!")
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "📊 Context Usage", value: "N/A", inline: true })
  })

  test("cleanup closes the subscription", async () => {
    const instance = harness()
    await instance.cleanup()
    expect(instance.closed).toBe(true)
    expect(instance.subscribe.mock.calls[0]?.[0]?.signal?.aborted).toBe(true)
  })

  test("cleanup aborts an outstanding webhook without logging an error", async () => {
    const started = Promise.withResolvers<AbortSignal>()
    fetchSpy.mockImplementationOnce(
      Object.assign(
        (_url: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal
            started.resolve(signal)
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          }),
        { preconnect: fetch.preconnect },
      ),
    )
    const log = spyOn(console, "error").mockImplementation(() => {})
    const instance = harness()
    const sent = instance.send(permission)
    const signal = await started.promise
    await instance.cleanup()
    await sent
    expect(signal.aborted).toBe(true)
    expect(instance.closed).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  test("webhook requests carry the 10-second timeout", async () => {
    const timeout = spyOn(AbortSignal, "timeout")
    await harness().send(permission)
    expect(timeout).toHaveBeenCalledWith(10_000)
  })

  test("cleanup during session lookup prevents a later webhook", async () => {
    const lookup = Promise.withResolvers<Session>()
    const instance = harness()
    instance.get.mockImplementationOnce(() => lookup.promise)
    const sent = instance.send(permission)
    await Promise.resolve()
    const stopped = instance.cleanup()
    lookup.resolve(session)
    await Promise.all([sent, stopped])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(instance.closed).toBe(true)
  })

  test("subscription failures do not escape setup or cleanup", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    const cleanup = await plugin.setup({
      options: config,
      event: {
        subscribe() {
          throw new Error("offline")
        },
      },
    } as unknown as Plugin.Context)
    await cleanup?.()
    expect(log).toHaveBeenCalledTimes(1)
  })
})
