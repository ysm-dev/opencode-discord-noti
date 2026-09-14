import type { Plugin } from "@opencode/plugin"

/** Options in OpenCode v2's { package, options } plugin entry. */
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

export declare const DiscordNotificationPlugin: Plugin.Plugin
export default DiscordNotificationPlugin
