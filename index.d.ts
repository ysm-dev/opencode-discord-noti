import type { Plugin } from "@opencode/plugin"

/** Options in OpenCode v2's { package, options } plugin entry. */
export interface DiscordNotificationOptions {
  /** Discord webhook URL. Required to send notifications. */
  webhookUrl?: string
  /**
   * Base URL of the OpenCode web/serve/desktop app for that instance, e.g. "http://localhost:4096".
   * When set, notifications link to the session in that app. Only the origin (protocol, host, port) is used.
   */
  webUrl?: string
  /** Enable notifications. Defaults to false. */
  enabled?: boolean
  /** Webhook display name. Defaults to "OpenCode Notifier". */
  username?: string
  /** Optional webhook avatar URL. */
  avatarUrl?: string
}

export declare const DiscordNotificationPlugin: Plugin.Plugin
export default DiscordNotificationPlugin
