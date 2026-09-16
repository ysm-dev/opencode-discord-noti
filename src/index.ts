import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import type { DiscordNotificationOptions } from "../index"

type Event = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never
type Session = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type Form = Extract<Event, { type: "form.created" }>["data"]["form"]
type Config = DiscordNotificationOptions & { webhookUrl: string }
type Field = { name: string; value: string; inline: boolean }
type Embed = { title: string; description: string; color: number; fields: Field[] }

export const DiscordNotificationPlugin = Plugin.define({
  id: "opencode-discord-noti",
  setup(ctx) {
    const input = ctx.options
    if (input.enabled !== true || typeof input.webhookUrl !== "string" || !input.webhookUrl.trim()) return
    const config: Config = {
      webhookUrl: input.webhookUrl.trim(),
      username: typeof input.username === "string" ? input.username : undefined,
      avatarUrl: typeof input.avatarUrl === "string" ? input.avatarUrl : undefined,
    }
    const controller = new AbortController()
    const task = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break
          try {
            await handleEvent(ctx, config, event, controller.signal)
          } catch (error) {
            if (!controller.signal.aborted) reportError("notification", error)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) reportError("subscription", error)
      }
    })()
    return async () => {
      controller.abort()
      await task
    }
  },
})

async function handleEvent(ctx: Plugin.Context, config: Config, event: Event, signal: AbortSignal) {
  if (
    event.type !== "session.execution.succeeded" &&
    event.type !== "permission.asked" &&
    event.type !== "form.created"
  )
    return
  if (event.type === "form.created" && event.data.form.metadata?.kind !== "question") return
  const sessionID = event.type === "form.created" ? event.data.form.sessionID : event.data.sessionID
  if (sessionID === "global") return

  // External subscriptions can observe every Location, although setup is Location-scoped.
  if (event.location && !sameLocation(event.location, ctx.location)) return
  const session = await ctx.session.get({ sessionID })
  if (!event.location && !sameLocation(session.location, ctx.location)) return
  if (signal.aborted) return

  if (event.type === "session.execution.succeeded") {
    if (session.parentID !== undefined) return
    await handleCompletion(ctx, config, session, signal)
    return
  }
  if (event.type === "permission.asked") {
    const permission = event.data
    const fields = sessionFields(session)
    fields.push({ name: "🔒 Type", value: permission.action, inline: true })
    if (permission.resources.length) {
      fields.push({
        name: "🎯 Resources",
        value: `\`\`\`\n${trim(permission.resources.join(", "), 800)}\n\`\`\``,
        inline: false,
      })
    }
    await post(
      config,
      sessionID,
      {
        title: "⚠️ Permission Required",
        description: permission.message || "OpenCode is waiting for permission.",
        color: 0xffa500,
        fields,
      },
      signal,
    )
    return
  }
  const form = event.data.form
  const tool = record(form.metadata?.tool)
  await post(
    config,
    sessionID,
    {
      title: "❓ Question Asked",
      description: formatQuestion(form),
      color: 0x3498db,
      fields: [
        ...sessionFields(session),
        { name: "🛠️ Tool", value: "question", inline: true },
        { name: "🆔 Call ID", value: typeof tool.id === "string" && tool.id ? tool.id : "n/a", inline: true },
      ],
    },
    signal,
  )
}

async function handleCompletion(ctx: Plugin.Context, config: Config, session: Session, signal: AbortSignal) {
  const messages = await ctx.session.context({ sessionID: session.id })
  const assistants = messages
    .filter((message) => message.type === "assistant")
    .filter((message) => message.time.completed !== undefined)
  const last = assistants.at(-1)
  const text = last?.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  // Match v2's context meter: usage after the most recent completed compaction only.
  const compaction = messages.findLastIndex(
    (message) => message.type === "compaction" && message.status === "completed",
  )
  const usage = messages.findLast(
    (message, index) =>
      index > compaction &&
      message.type === "assistant" &&
      message.time.completed !== undefined &&
      message.tokens !== undefined,
  )
  const tokens = usage?.type === "assistant" ? usage.tokens : undefined
  const model = usage?.type === "assistant" ? usage.model : undefined
  const models = model ? await ctx.model.list().catch(() => undefined) : undefined
  const limit = models?.data.find((item) => item.id === model?.id && item.providerID === model?.providerID)?.limit
    .context
  const ref = last?.model || session.model
  await post(
    config,
    session.id,
    {
      title: "✅ Response Completed",
      description: text || "Response completed.",
      color: 0x00ff00,
      fields: [
        ...sessionFields(session),
        {
          name: "📊 Context Usage",
          value:
            tokens && totalTokens(tokens) > 0 && limit ? `${((totalTokens(tokens) / limit) * 100).toFixed(2)}%` : "N/A",
          inline: true,
        },
        { name: "🔢 Session Tokens", value: `${totalTokens(session.tokens).toLocaleString()} tokens`, inline: true },
        { name: "🤖 Model", value: ref ? `${ref.providerID}/${ref.id}` : "Unknown", inline: true },
      ],
    },
    signal,
  )
}

function totalTokens(tokens: Session["tokens"]): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function sameLocation(a: Session["location"], b: Session["location"]): boolean {
  return a.directory === b.directory
}

function sessionFields(session: Session): Field[] {
  return [
    { name: "📝 Session", value: session.title || "(untitled)", inline: true },
    { name: "📁 Directory", value: shortPath(session.location.directory), inline: true },
  ]
}

function shortPath(path: string): string {
  const home = process.env.HOME || homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.substring(home.length)}` : path
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function trim(text: string, limit: number): string {
  return text.length > limit ? `${text.substring(0, limit - 3)}...` : text
}

function formatQuestion(form: Form): string {
  return (
    form.fields
      .map((field, index) => {
        const header = field.title ? ` _[${field.title}]_` : ""
        const options = field.type === "string" || field.type === "multiselect" ? field.options : undefined
        const body = `**Q${index + 1}${header}: ${field.description || field.title || field.key}**`
        const choices = options
          ?.map((option) => `• **${option.label}**${option.description ? ` — ${option.description}` : ""}`)
          .join("\n")
        return choices ? `${body}\n${choices}` : body
      })
      .join("\n\n") || form.title
  )
}

function reportError(kind: string, error: unknown) {
  // Never print a webhook URL/token from a fetch error.
  console.error(`opencode-discord-noti (${kind}): failed`, error instanceof Error ? error.name : "Error")
}

async function post(config: Config, sessionID: string, embed: Embed, signal: AbortSignal) {
  if (signal.aborted) return
  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
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

export default DiscordNotificationPlugin
