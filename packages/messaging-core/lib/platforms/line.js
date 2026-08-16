/**
 * platform-line — LINE messaging adapter for DSH.
 *
 * Webhook route /line on the messaging-core shared listener (default
 * 127.0.0.1:8765 — expose via reverse proxy/tunnel and register the public
 * callback URL in the LINE Developer Console). X-Line-Signature is verified
 * with the channel secret. Inbound text messages are acknowledged quickly
 * (LINE reply tokens expire after 60s); the agent's answer uses the reply
 * token when still valid, otherwise LINE pushMessage. Group messages require
 * a bot @mention.
 *
 * Configuration (settings namespace `messaging-line`):
 *   channelAccessToken: LINE channel access token (secret)
 *   channelSecret:      LINE channel secret (secret)
 *   allowedUsers:       LINE user ids allowed to talk to the bot
 *   allowAll:           true to accept everyone (dev only)
 *   validateSignature:  verify X-Line-Signature (default true)
 *   publicUrl:          public callback base URL, e.g. https://bot.example.com
 *                       (informational; route is /line)
 *   homeChannel:        reserved
 */
import z from 'schemastery'
import { messagingApi, validateSignature } from '@line/bot-sdk'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('line')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-line'), z.object({
      channelAccessToken: z.string().role('secret').default(''),
      channelSecret: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      validateSignature: z.boolean().default(true),
      publicUrl: z.string().default(''),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-line' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      channelAccessToken: (resolved.channelAccessToken && resolved.channelAccessToken.trim()) || process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
      channelSecret: (resolved.channelSecret && resolved.channelSecret.trim()) || process.env.LINE_CHANNEL_SECRET || '',
    }
  }

  let client = null
  let botUserId = null
  /** chatId -> { token, expiresAt } — LINE reply tokens expire after 60s. */
  const pendingReplies = new Map()

  const adapter = {
    id: 'line',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 5000,
    },
    resolveConfig,

    async connect() {
      if (client) return
      const cfg = resolveConfig()
      if (!cfg.channelAccessToken || !cfg.channelSecret) {
        logger.warn('line: 未配置（settings messaging-line.channelAccessToken/channelSecret）')
        return
      }
      const c = new messagingApi.MessagingApiClient({ channelAccessToken: cfg.channelAccessToken })
      client = c
      try {
        const info = await c.getBotInfo()
        botUserId = info.userId
      } catch (error) {
        logger.warn(`line getBotInfo failed: ${error.message}`)
      }
      unregisterWebhook = ctx.messaging.registerWebhook('/line', handleWebhook)
      adapter.connected = true
      logger.info(`line webhook ready at /line${cfg.publicUrl ? ` (public: ${cfg.publicUrl}/line)` : ''}`)
    },

    async disconnect() {
      if (unregisterWebhook) {
        try {
          unregisterWebhook()
        } catch { /* ignore */ }
        unregisterWebhook = null
      }
      client = null
      botUserId = null
      adapter.connected = false
    },

    async send(target, text) {
      if (!client) throw new Error('line: not connected')
      const pending = pendingReplies.get(target.chatId)
      if (pending && Date.now() < pending.expiresAt) {
        pendingReplies.delete(target.chatId)
        await client.replyMessage({ replyToken: pending.token, messages: [{ type: 'text', text }] })
        return {}
      }
      await client.pushMessage({ to: target.chatId.split(':').slice(1).join(':'), messages: [{ type: 'text', text }] })
      return {}
    },

    async sendTyping() { /* LINE loading animation unsupported in M0 */ },

    async sendMedia() {
      throw new Error('line: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      const raw = chatId.split(':').slice(1).join(':')
      return { name: raw, type: chatId.split(':')[0], chatId }
    },
  }

  let unregisterWebhook = null
  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.channelAccessToken && initial.channelSecret) {
    adapter.connect().catch((error) => logger.error(`line connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('line: 未配置，等待配置（settings messaging-line）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.channelAccessToken && next.channelSecret && !client) {
        adapter.connect().catch((error) => logger.error(`line connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** LINE webhook: verify signature, dispatch text messages, ack fast. */
  async function handleWebhook({ raw, headers, res }) {
    const cfg = resolveConfig()
    const signature = headers['x-line-signature']
    if (cfg.validateSignature !== false) {
      if (!signature || !validateSignature(cfg.channelSecret, raw.toString('utf8'), String(signature))) {
        res.writeHead(401)
        res.end()
        return
      }
    }
    let payload
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    res.writeHead(200)
    res.end()
    for (const event of payload.events || []) {
      handleEvent(event).catch((error) => logger.error(`line event failed: ${error.stack || error.message}`))
    }
  }

  /** Normalize one LINE event into a messaging-core inbound event. */
  async function handleEvent(event) {
    if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') return
    const source = event.source
    if (!source || !source.type) return
    const isChat = source.type === 'group' || source.type === 'room'
    const userId = source.userId || 'line-unknown'
    const chatId = `${source.type}:${source.type === 'user' ? userId : (source.groupId || source.roomId)}`
    if (!chatId || chatId.endsWith(':')) return

    const text = String(event.message.text || '').trim()
    if (!text) return

    if (isChat) {
      const mentioned = event.message.mention && Array.isArray(event.message.mention.mentionees)
        ? event.message.mention.mentionees.some((m) => botUserId && m.userId === botUserId)
        : false
      if (!mentioned) return
    }

    if (event.replyToken) {
      pendingReplies.set(chatId, { token: event.replyToken, expiresAt: Date.now() + 55000 })
    }

    await ctx.messaging.handleInbound('line', {
      platform: 'line',
      chatKey: `line:${chatId}`,
      chatId,
      userId: String(userId),
      userName: userId,
      text,
      raw: event,
    })
  }
}
