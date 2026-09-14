import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import plugin, { DiscordNotificationPlugin } from "../src/index"

const webhookUrl = "https://discord.invalid/api/webhooks/test/token"
const config = { enabled: true, webhookUrl, username: "Test Notifier", avatarUrl: "https://example.com/avatar.png" }
const permission = {
  id: "permission-1",
  type: "bash",
  sessionID: "session-1",
  messageID: "message-1",
  title: "Run a command?",
  pattern: ["git status", "git diff"],
  metadata: {},
  time: { created: 1 },
}
const tool = { tool: "question", sessionID: "session-1", callID: "call-1" }
let home: string
let previousHome: string | undefined
let hooks: Hooks
let context: PluginInput
let session: Record<string, unknown>
let messages: Record<string, unknown>[]
let get: ReturnType<typeof mock>
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>

interface Payload {
  username: string
  avatar_url: string
  allowed_mentions: { parse: string[] }
  embeds: {
    title: string
    description: string
    color: number
    fields: { name: string; value: string; inline: boolean }[]
    footer: { text: string }
  }[]
}

function payload(): Payload {
  return JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))
}

async function configure(value?: Record<string, unknown>) {
  hooks = await plugin(context, value)
}

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "opencode-discord-noti-test-"))
  process.env.HOME = home
  await mkdir(join(home, ".config/opencode"), { recursive: true })
  session = { title: "My session", directory: join(home, "project") }
  messages = []
  get = mock(async () => ({ data: session }))
  const client = { session: { get, messages: mock(async () => ({ data: messages })) } }
  context = { client, project: {} } as unknown as PluginInput
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }))
  await configure(config)
})

afterEach(async () => {
  mock.restore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("v1 notification hooks", () => {
  test("exports the same named and default plugin", () => {
    expect(plugin).toBe(DiscordNotificationPlugin)
  })

  test("sends permission details without changing the permission decision", async () => {
    const output = { status: "ask" as const }
    await hooks["permission.ask"]!(permission, output)
    expect(output).toEqual({ status: "ask" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(webhookUrl)
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST")
    const body = payload()
    expect(body.username).toBe(config.username)
    expect(body.avatar_url).toBe(config.avatarUrl)
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.embeds[0]?.color).toBe(0xffa500)
    expect(body.embeds[0]?.fields).toContainEqual({ name: "📁 Directory", value: "~/project", inline: true })
    expect(body.embeds[0]?.fields).toContainEqual({
      name: "🎯 Pattern",
      value: "```\ngit status, git diff\n```",
      inline: false,
    })
  })

  test("skips auto-allowed permissions and retains auto-denied status", async () => {
    await hooks["permission.ask"]!(permission, { status: "allow" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    await hooks["permission.ask"]!(permission, { status: "deny" })
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "🚫 Status", value: "auto-denied", inline: true })
  })

  test.each([
    "Question",
    "mcp_Question",
    "mcp__Question",
    "ask",
    "ask_question",
    "custom.question",
  ])("notifies for %s with question options", async (name) => {
    const args = {
      questions: [
        { header: "Publish", question: "Which version?", options: [{ label: "v1", description: "Keep v1" }] },
      ],
    }
    await hooks["tool.execute.before"]!({ ...tool, tool: name }, { args })
    expect(payload().embeds[0]?.description).toContain("Which version?")
    expect(payload().embeds[0]?.description).toContain("• **v1** — Keep v1")
    expect(payload().embeds[0]?.color).toBe(0x3498db)
    expect(args.questions[0]?.question).toBe("Which version?")
  })

  test("ignores unrelated tools and events", async () => {
    await hooks["tool.execute.before"]!({ ...tool, tool: "bash" }, { args: { command: "pwd" } })
    await hooks.event!({ event: { type: "server.connected", properties: {} } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    undefined,
    {},
    { enabled: false, webhookUrl },
    { enabled: true },
    { webhookUrl },
    { enabled: "true", webhookUrl },
    { enabled: true, webhookUrl: 123 },
    { enabled: true, webhookUrl: "  " },
  ])("does not notify with absent, disabled, or invalid options: %j", async (value) => {
    await configure(value)
    await hooks["tool.execute.before"]!(tool, { args: { question: "Ready?" } })
    await hooks["permission.ask"]!(permission, { status: "ask" })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  test("does not fall back to the old configuration file or project.config", async () => {
    await writeFile(join(home, ".config/opencode/discord-notification-config.json"), JSON.stringify(config))
    context = { ...context, project: { config: { discordNotifications: config } } } as unknown as PluginInput
    await configure()
    await hooks["permission.ask"]!(permission, { status: "ask" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("keeps options isolated between plugin instances", async () => {
    const first = hooks
    await configure({ ...config, webhookUrl: "https://discord.invalid/second" })
    await first["permission.ask"]!(permission, { status: "ask" })
    await hooks["permission.ask"]!(permission, { status: "ask" })
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([webhookUrl, "https://discord.invalid/second"])
  })

  test("captures options at initialization without mutating the caller's object", async () => {
    const options = { ...config, webhookUrl: ` ${webhookUrl} ` }
    await configure(options)
    expect(options.webhookUrl).toBe(` ${webhookUrl} `)
    options.webhookUrl = "https://discord.invalid/changed"
    await hooks["permission.ask"]!(permission, { status: "ask" })
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(webhookUrl)
  })

  test("uses default display settings for missing or invalid optional values", async () => {
    await configure({ enabled: true, webhookUrl, username: 123, avatarUrl: false })
    await hooks["permission.ask"]!(permission, { status: "ask" })
    expect(payload().username).toBe("OpenCode Notifier")
    expect(payload()).not.toHaveProperty("avatar_url")
  })

  test("uses fallback session details when lookup fails", async () => {
    get.mockRejectedValue(new Error("offline"))
    await hooks["tool.execute.before"]!(tool, { args: { question: "Ready?" } })
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "📝 Session", value: "(untitled)", inline: true })
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "📁 Directory", value: "n/a", inline: true })
  })

  test("bounds long question descriptions and session fields for Discord", async () => {
    session.title = "x".repeat(2000)
    await hooks["tool.execute.before"]!(tool, { args: { question: "q".repeat(5000) } })
    expect(payload().embeds[0]?.description.length).toBe(1500)
    expect(payload().embeds[0]?.fields[0]?.value.length).toBe(1024)
  })

  test.each([
    null,
    {},
    { questions: [] },
    { questions: [null] },
    { question: "" },
  ])("formats incomplete question arguments: %j", async (args) => {
    await hooks["tool.execute.before"]!(tool, { args })
    expect(payload().embeds[0]?.description.length).toBeGreaterThan(0)
  })

  test("HTTP failures are contained", async () => {
    fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }))
    const log = spyOn(console, "error").mockImplementation(() => {})
    await hooks["permission.ask"]!(permission, { status: "ask" })
    expect(log).toHaveBeenCalledTimes(1)
  })

  test("network failures are contained without logging webhook secrets", async () => {
    fetchSpy.mockRejectedValue(new Error(`Request failed: ${webhookUrl}`))
    const log = spyOn(console, "error").mockImplementation(() => {})
    await hooks["permission.ask"]!(permission, { status: "ask" })
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(webhookUrl)
  })

  test("completion includes last assistant text, model, and peak token usage", async () => {
    session.model = { limit: { context: 1000 } }
    messages = [
      {
        info: { role: "assistant", tokens: { input: 200, output: 50, cache: { read: 50 } } },
        parts: [{ type: "text", text: "Earlier" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "User text" }] },
      {
        info: { role: "assistant", modelID: "test-model", tokens: { input: 100, output: 25 } },
        parts: [
          { type: "reasoning", text: "Hidden" },
          { type: "text", text: "Done!" },
        ],
      },
    ]
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    const embed = payload().embeds[0]!
    expect(embed.description).toBe("Done!")
    expect(embed.color).toBe(0x00ff00)
    expect(embed.fields).toContainEqual({ name: "📊 Context Usage", value: "30.00%", inline: true })
    expect(embed.fields).toContainEqual({ name: "🔢 Total Tokens", value: "300 tokens", inline: true })
    expect(embed.fields).toContainEqual({ name: "🤖 Model", value: "test-model", inline: true })
    expect(embed.footer.text).toBe("Session ID: session-1")
  })

  test("skips subagent completion notifications", async () => {
    session.parentID = "parent-1"
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("completion handles empty messages and missing model metadata", async () => {
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session-1" } } })
    expect(payload().embeds[0]?.description).toBe("Response completed.")
    expect(payload().embeds[0]?.fields).toContainEqual({ name: "📊 Context Usage", value: "N/A", inline: true })
  })
})
