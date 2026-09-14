import { homedir } from "node:os"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { DiscordNotificationOptions } from "../index"

type DiscordWebhookConfig = DiscordNotificationOptions

type Client = PluginInput["client"]
type Permission = Parameters<NonNullable<Hooks["permission.ask"]>>[0]
type PermissionOutput = Parameters<NonNullable<Hooks["permission.ask"]>>[1]
type ToolInput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[0]
type Field = { name: string; value: string; inline: boolean }
type Embed = { title: string; description: string; color: number; fields: Field[] }

// Also accept the unwrapped responses used by older v1 clients.
interface SessionSnapshot {
  title?: string
  directory?: string
  parentID?: string
  model?: { name?: string; limit?: { context?: number } }
}

interface MessageInfo {
  role?: string
  modelID?: string
  tokens?: { input?: number; output?: number; cache?: { read?: number } }
}

interface MessageSnapshot extends MessageInfo {
  info?: MessageInfo
  parts?: { type: string; text?: string }[]
}

export const DiscordNotificationPlugin: Plugin = async ({ client }, options) => {
  const input = record(options)
  const config: DiscordNotificationOptions = {
    enabled: input.enabled === true,
    webhookUrl: typeof input.webhookUrl === "string" ? input.webhookUrl.trim() : undefined,
    username: typeof input.username === "string" ? input.username : undefined,
    avatarUrl: typeof input.avatarUrl === "string" ? input.avatarUrl : undefined,
  }
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await notify(config, "idle", (config) => handleIdle(client, config, event.properties.sessionID))
      }
    },
    "permission.ask": async (input, output) => {
      if (output.status === "allow") return
      await notify(config, "permission", (config) => handlePermission(client, config, input, output))
    },
    "tool.execute.before": async (input, output) => {
      if (!isQuestionTool(input.tool)) return
      await notify(config, "question", (config) => handleQuestion(client, config, input, output.args))
    },
  }
}

function shortPath(path: string | undefined): string {
  if (!path) return "n/a"
  const home = process.env.HOME || homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.substring(home.length)}` : path
}

function isQuestionTool(tool: string): boolean {
  const name = tool.toLowerCase()
  return name === "question" || name === "ask" || name.endsWith("_question") || name.endsWith(".question")
}

async function notify(
  config: DiscordWebhookConfig,
  kind: string,
  send: (config: DiscordWebhookConfig & { webhookUrl: string }) => Promise<void>,
): Promise<void> {
  try {
    if (!config.enabled || !config.webhookUrl) return
    await send({ ...config, webhookUrl: config.webhookUrl })
  } catch (error) {
    // Never interrupt the session or print a webhook URL/token from a fetch error.
    console.error(`opencode-discord-noti (${kind}): notification failed`, error instanceof Error ? error.name : "Error")
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function trim(text: string, limit: number): string {
  return text.length > limit ? `${text.substring(0, limit - 3)}...` : text
}

function formatQuestionArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "(no arguments)"
  const input = record(args)
  if (Array.isArray(input.questions)) {
    return (
      input.questions
        .map((item, index) => {
          const question = record(item)
          const header = question.header ? ` _[${question.header}]_` : ""
          const options = Array.isArray(question.options)
            ? question.options
                .map((item) => {
                  const option = record(item)
                  return `• **${option.label}**${option.description ? ` — ${option.description}` : ""}`
                })
                .join("\n")
            : ""
          const body = `**Q${index + 1}${header}: ${question.question || "(no question text)"}**`
          return options ? `${body}\n${options}` : body
        })
        .join("\n\n") || "(no questions)"
    )
  }
  if (typeof input.question === "string") return input.question || "(no question text)"
  return `\`\`\`json\n${trim(JSON.stringify(args, null, 2), 1400)}\n\`\`\``
}

function unwrap<T>(response: { data?: T } | T): T {
  return ((response as { data?: T }).data || response) as T
}

async function sessionDetails(client: Client, sessionID: string): Promise<SessionSnapshot> {
  try {
    return unwrap<SessionSnapshot>(await client.session.get({ path: { id: sessionID } }))
  } catch {
    return {}
  }
}

function sessionFields(session: SessionSnapshot): Field[] {
  return [
    { name: "📝 Session", value: session.title || "(untitled)", inline: true },
    { name: "📁 Directory", value: shortPath(session.directory), inline: true },
  ]
}

async function post(config: DiscordWebhookConfig & { webhookUrl: string }, sessionID: string, embed: Embed) {
  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      username: config.username || "OpenCode Notifier",
      avatar_url: config.avatarUrl,
      allowed_mentions: { parse: [] },
      embeds: [
        {
          ...embed,
          description: trim(embed.description, 1500),
          fields: embed.fields.map((field) => ({ ...field, value: trim(field.value, 1024) })),
          footer: { text: trim(`Session ID: ${sessionID}`, 2048) },
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`)
}

async function handlePermission(
  client: Client,
  config: DiscordWebhookConfig & { webhookUrl: string },
  input: Permission,
  output: PermissionOutput,
) {
  const session = await sessionDetails(client, input.sessionID)
  const fields = sessionFields(session)
  fields.push({ name: "🔒 Type", value: input.type || "unknown", inline: true })
  if (input.pattern) {
    const pattern = Array.isArray(input.pattern) ? input.pattern.join(", ") : input.pattern
    fields.push({ name: "🎯 Pattern", value: `\`\`\`\n${trim(pattern, 800)}\n\`\`\``, inline: false })
  }
  if (output.status === "deny") fields.push({ name: "🚫 Status", value: "auto-denied", inline: true })
  await post(config, input.sessionID, {
    title: "⚠️ Permission Required",
    description: input.title || "OpenCode is waiting for permission.",
    color: 0xffa500,
    fields,
  })
}

async function handleQuestion(
  client: Client,
  config: DiscordWebhookConfig & { webhookUrl: string },
  input: ToolInput,
  args: unknown,
) {
  const session = await sessionDetails(client, input.sessionID)
  await post(config, input.sessionID, {
    title: "❓ Question Asked",
    description: formatQuestionArgs(args),
    color: 0x3498db,
    fields: [
      ...sessionFields(session),
      { name: "🛠️ Tool", value: input.tool || "unknown", inline: true },
      { name: "🆔 Call ID", value: input.callID || "n/a", inline: true },
    ],
  })
}

async function handleIdle(client: Client, config: DiscordWebhookConfig & { webhookUrl: string }, sessionID: string) {
  if (!sessionID) return
  // Give the final message and token usage time to settle.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const [sessionResponse, messagesResponse] = await Promise.all([
    client.session.get({ path: { id: sessionID } }),
    client.session.messages({ path: { id: sessionID } }),
  ])
  const session = unwrap<SessionSnapshot>(sessionResponse)
  if (session.parentID !== undefined) return
  const messages = unwrap<MessageSnapshot[]>(messagesResponse)
  const assistants = messages.filter((message) => (message.info?.role || message.role) === "assistant")
  let tokens = 0
  for (const message of assistants) {
    const usage = message.info?.tokens || message.tokens
    if (usage) tokens = Math.max(tokens, (usage.input || 0) + (usage.output || 0) + (usage.cache?.read || 0))
  }
  const last = assistants.at(-1)
  const text = last?.parts
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const context = session.model?.limit?.context
  await post(config, sessionID, {
    title: "✅ Response Completed",
    description: text || "Response completed.",
    color: 0x00ff00,
    fields: [
      ...sessionFields(session),
      {
        name: "📊 Context Usage",
        value: tokens > 0 && context ? `${((tokens / context) * 100).toFixed(2)}%` : "N/A",
        inline: true,
      },
      { name: "🔢 Total Tokens", value: `${tokens.toLocaleString()} tokens`, inline: true },
      {
        name: "🤖 Model",
        value: last?.info?.modelID || last?.modelID || session.model?.name || "Unknown",
        inline: true,
      },
    ],
  })
}

export default DiscordNotificationPlugin
