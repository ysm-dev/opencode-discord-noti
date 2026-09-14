import type { Hooks, PluginInput } from "@opencode-ai/plugin"

/** Options in OpenCode v1's [package, options] plugin entry. */
export interface DiscordNotificationOptions {
  /** Discord webhook URL. Required to send notifications. */
  webhookUrl?: string
  /** Enable notifications. Defaults to false. */
  enabled?: boolean
  /** Webhook display name. Defaults to "OpenCode Notifier". */
  username?: string
  /** Optional webhook avatar URL. */
  avatarUrl?: string
}

export declare const DiscordNotificationPlugin: (
  input: PluginInput,
  options?: DiscordNotificationOptions,
) => Promise<Hooks>
export default DiscordNotificationPlugin
