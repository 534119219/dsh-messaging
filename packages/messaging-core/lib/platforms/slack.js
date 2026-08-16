/**
 * platform-slack — Slack messaging adapter for DSH (Socket Mode).
 *
 * @slack/socket-mode + @slack/web-api; supports streaming edits via
 * chat.update (with a post-new-message fallback when the edit window is
 * closed), DMs + channel mention gating, and the shared allowlist
 * authorization provided by messaging-core.
 *
 * Configuration (settings namespace `messaging-slack`, or env fallback):
 *   appToken:    Slack app-level token (xapp-...) — env: SLACK_APP_TOKEN
 *   botToken:    Slack bot token (xoxb-...) — env: SLACK_BOT_TOKEN
 *   allowedUsers: array of Slack user ids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  default channel id for cron/notification delivery (reserved)
 *
 * App configuration required (api.slack.com/apps):
 *   - Socket Mode: ON
 *   - Event subscriptions: subscribe to message.im, message.channels,
 *     message.groups, message.mpim
 *   - Bot token scopes: chat:write, im:history, channels:history,
 *     groups:history, mpim:history
 */
import z from 'schemastery'
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('slack')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-slack'), z.object({
      appToken: z.string().role('secret').default(''),
      botToken: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-slack' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : { appToken: '', botToken: '', allowedUsers: [], allowAll: false, homeChannel: '' }
    return {
      ...resolved,
      appToken: (resolved.appToken && resolved.appToken.trim()) || process.env.SLACK_APP_TOKEN || '',
      botToken: (resolved.botToken && resolved.botToken.trim()) || process.env.SLACK_BOT_TOKEN || '',
    }
  }

  let socket = null
  let web = null
  let botUserId = null
  /** messageId (original ts) -> current ts, after edit-fallback reposts. */
  const editMap = new Map()

  const adapter = {
    id: 'slack',
    connected: false,
    capabilities: {
      streaming: true,
      typing: false,
      buttons: false,
      media: ['image'],
      markdown: 'plain',
      maxMessageLength: 39000,
    },
    resolveConfig,

    async connect() {
      if (socket) return
      const cfg = resolveConfig()
      if (!cfg.appToken || !cfg.botToken) {
        logger.warn('slack: 未配置 token（settings messaging-slack.appToken/botToken 或环境变量）')
        return
      }
      const w = new WebClient(cfg.botToken)
      const s = new SocketModeClient({ appToken: cfg.appToken })
      web = w
      socket = s
      try {
        const auth = await w.auth.test()
        botUserId = auth.user_id
      } catch (error) {
        socket = null
        web = null
        throw new Error(`slack auth.test failed: ${error.message}`)
      }
      s.on('message', (payload) => {
        handleMessage(payload).catch((error) => logger.error(`slack message failed: ${error.stack || error.message}`))
      })
      await s.start()
      adapter.connected = true
      logger.info(`slack connected (bot user ${botUserId})`)
    },

    async disconnect() {
      const s = socket
      socket = null
      web = null
      botUserId = null
      adapter.connected = false
      if (s) {
        try {
          await s.disconnect()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      const res = await web.chat.postMessage({ channel: target.chatId, text })
      return { messageId: res.ts }
    },

    async editMessage(target, messageId, text) {
      const ts = editMap.get(messageId) || messageId
      try {
        await web.chat.update({ channel: target.chatId, ts, text })
      } catch {
        // Edit unavailable (window closed, message gone): repost and remap so
        // later streaming edits keep hitting the visible message.
        const res = await web.chat.postMessage({ channel: target.chatId, text })
        editMap.set(messageId, res.ts)
      }
    },

    async sendTyping() { /* Slack has no typing API */ },

    async sendMedia(target, media, caption) {
      // M0: hosted-file uploads are not wired; post the URL as text.
      const text = caption ? `${caption}\n${media.url}` : media.url
      const res = await web.chat.postMessage({ channel: target.chatId, text })
      return { messageId: res.ts }
    },

    async getChatInfo(chatId) {
      const info = await web.conversations.info({ channel: chatId })
      const channel = info.channel
      return {
        name: channel && channel.name ? channel.name : String(chatId),
        type: channel && channel.is_im ? 'im' : 'channel',
        chatId: String(chatId),
      }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.appToken && initial.botToken) {
    adapter.connect().catch((error) => logger.error(`slack connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('slack: 未配置 token，等待配置（settings messaging-slack）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.appToken && next.botToken && !socket) {
        adapter.connect().catch((error) => logger.error(`slack connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Normalize one Slack message event into a messaging-core inbound event. */
  async function handleMessage(payload) {
    const event = payload && payload.event
    if (!event || event.type !== 'message') return
    if (event.subtype) return // bot_message / message_changed / ...
    if (event.bot_id) return
    if (!event.user || !event.text) return
    if (botUserId && event.user === botUserId) return

    let text = event.text
    if (event.channel_type !== 'im') {
      const mention = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`)
      if (!mention.test(text)) return
      text = text.replace(mention, '').trim()
    }
    if (!text) return

    await ctx.messaging.handleInbound('slack', {
      platform: 'slack',
      chatKey: `slack:${event.channel}`,
      chatId: String(event.channel),
      threadId: event.thread_ts ? String(event.thread_ts) : undefined,
      userId: String(event.user),
      text,
      raw: event,
    })
  }
}
