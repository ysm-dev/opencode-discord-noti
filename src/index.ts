import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import type { DiscordNotificationOptions } from "../index"

type Event = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never
type Session = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type Form = Extract<Event, { type: "form.created" }>["data"]["form"]
type Config = DiscordNotificationOptions & { webhookUrl: string; webUrl?: string }
type Field = { name: string; value: string; inline: boolean }
type Embed = { title: string; description: string; color: number; fields: Field[]; url?: string }
type LinkButton = { type: 2; style: 5; label: string; url: string }

// Error type that always strips the webhook URL (a bundled secret) from its message.
class RedactedError extends Error {
  constructor(message: string, webhookUrl: string) {
    super(message.split(webhookUrl).join("[redacted]"))
  }
}

const DEFAULT_USERNAME = "OpenCode Notifier"
// Discord caps webhook names at 80 characters and rejects reserved or branded names.
const USERNAME_LIMIT = 80
const USERNAME_BLOCKLIST = ["clyde", "discord", "everyone", "here"]
const EMBED_LIMIT = 6000
const EMBED_URL_LIMIT = 2048
const BUTTON_URL_LIMIT = 512

export const DiscordNotificationPlugin = Plugin.define({
  id: "opencode-discord-noti",
  setup(ctx) {
    const input = ctx.options
    if (input.enabled !== true || typeof input.webhookUrl !== "string" || !input.webhookUrl.trim()) return
    let webUrl: string | undefined
    if (typeof input.webUrl === "string" && input.webUrl.trim()) {
      try {
        webUrl = normalizeWebUrl(input.webUrl)
      } catch {
        reportError("config", new Error("invalid webUrl"))
      }
    }
    const config: Config = {
      webhookUrl: input.webhookUrl.trim(),
      username: typeof input.username === "string" ? effectiveUsername(input.username) : undefined,
      avatarUrl: typeof input.avatarUrl === "string" ? input.avatarUrl : undefined,
      webUrl,
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

  const url = config.webUrl ? sessionUrl(config.webUrl, session.id) : undefined
  if (event.type === "session.execution.succeeded") {
    if (session.parentID !== undefined) return
    await handleCompletion(ctx, config, session, signal, url)
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
        url,
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
      url,
    },
    signal,
  )
}

function normalizeWebUrl(input: string): string {
  const trimmed = input.trim()
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  const parsed = new URL(withProtocol)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol")
  if (!parsed.hostname) throw new Error("missing hostname")
  return parsed.origin
}

// The web/desktop app keys servers by URL, so the route encodes the same base URL OpenCode normalizes.
function sessionUrl(base: string, sessionID: string): string {
  const server = Buffer.from(base).toString("base64url")
  return `${base}/server/${server}/session/${sessionID}`
}

async function handleCompletion(
  ctx: Plugin.Context,
  config: Config,
  session: Session,
  signal: AbortSignal,
  url?: string,
) {
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
      url,
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
  if (text.length <= limit) return text
  let cut = limit - 3
  // Never split a surrogate pair; the goal is a well-formed string even at the boundary.
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) cut -= 1
  return `${text.substring(0, cut)}...`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function effectiveUsername(username: string): string | undefined {
  const name = username.trim()
  const blocked = USERNAME_BLOCKLIST.some((word) => name.toLowerCase().includes(word))
  if (!name || name.length > USERNAME_LIMIT || blocked) return DEFAULT_USERNAME
  return name
}

// Discord caps each piece and the combined embed (title, description, field names/values, footer, url) at 6000.
function fitEmbed(embed: Embed): Embed {
  const sized = {
    ...embed,
    description: trim(embed.description, 1500),
    fields: embed.fields.map((field) => ({ ...field, value: trim(field.value, 1024) })),
  }
  const used =
    sized.title.length +
    sized.fields.reduce((total, field) => total + field.name.length + field.value.length, 0) +
    (sized.url?.length ?? 0)
  const available = Math.max(0, EMBED_LIMIT - used)
  return { ...sized, description: trim(sized.description, available) }
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
  // Never print a webhook URL/token from a fetch error: diagnostic bodies are redacted before logging.
  if (error instanceof Error) console.error(`opencode-discord-noti (${kind}): failed [${error.name}] ${error.message}`)
  else console.error(`opencode-discord-noti (${kind}): failed Error`)
}

const RETRY_LIMIT = 2

async function post(config: Config, sessionID: string, embed: Embed, signal: AbortSignal) {
  if (signal.aborted) return
  const webhook = new URL(config.webhookUrl)
  // Discord rejects embed urls over 2048 characters; dropping one is better than dropping the notification.
  const url = embed.url && embed.url.length <= EMBED_URL_LIMIT ? embed.url : undefined
  const body: Record<string, unknown> = {
    username: config.username || DEFAULT_USERNAME,
    avatar_url: config.avatarUrl,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        ...fitEmbed({ ...embed, url }),
        footer: { text: trim(`Session ID: ${sessionID}`, 2048) },
        timestamp: new Date().toISOString(),
      },
    ],
  }
  if (url) {
    // Plain incoming webhooks must opt in before Discord keeps non-interactive components.
    webhook.searchParams.set("with_components", "true")
    const button = linkButton(url)
    if (button) body.components = [{ type: 1, components: [button] }]
  }
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return
    let response: Response
    try {
      response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        body: JSON.stringify(body),
      })
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : "request failed"
      const wrapped = new RedactedError(message, config.webhookUrl)
      wrapped.name = "NetworkError"
      throw wrapped
    }
    if (response.ok) return
    if (response.status === 429 && attempt < RETRY_LIMIT) {
      await sleep((await retryDelay(response)) * (attempt + 1), signal)
      continue
    }
    const error = new RedactedError(await diagnostic(response, config.webhookUrl), config.webhookUrl)
    error.name = `DiscordHTTP${response.status}`
    throw error
  }
}

function linkButton(url: string): LinkButton | undefined {
  // Discord rejects link buttons whose url exceeds 512 characters.
  if (url.length > BUTTON_URL_LIMIT) return undefined
  return { type: 2, style: 5, label: "🌐 Open Session", url }
}

async function retryDelay(response: Response): Promise<number> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  const retryAfter = record(body).retry_after
  // Discord reports seconds; cap the wait so a hostile value cannot stall the subscriber.
  const seconds = typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : 1
  return Math.min(5, Math.max(0, seconds)) * 1000
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      done()
    }
    function done() {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function diagnostic(response: Response, webhookUrl: string): Promise<string> {
  try {
    const text = trim((await response.text()).trim(), 300)
    return text ? redact(text, webhookUrl) : "no response body"
  } catch {
    return "response body unavailable"
  }
}

function redact(text: string, webhookUrl: string): string {
  return text.replaceAll(webhookUrl, "[redacted]").replaceAll(encodeURI(webhookUrl), "[redacted]")
}

export default DiscordNotificationPlugin
