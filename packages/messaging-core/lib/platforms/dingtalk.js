/**
 * platform-dingtalk — DingTalk messaging adapter for DSH (Stream mode).
 *
 * Official dingtalk-stream SDK (DWClient): no public URL needed — the SDK
 * handles ticket/endpoint negotiation, WebSocket connection, subscription
 * (TOPIC_ROBOT) and automatic acks. Inbound messages carry a per-session
 * webhook (sessionWebhook, ~2h expiry); replies POST markdown to it, cached
 * per chat with expiry tracking (mirrors hermes-agent's dingtalk adapter).
 *
 * Configuration (settings namespace `messaging-dingtalk`):
 *   clientId:      DingTalk app AppKey (env: DINGTALK_CLIENT_ID)
 *   clientSecret:  DingTalk app AppSecret (env: DINGTALK_CLIENT_SECRET)
 *   allowedUsers:  senderStaffId / senderId values allowed to talk to the bot
 *   allowAll:      true to accept everyone (dev only)
 *   requireMention: require @mention in group chats (default true)
 *   freeResponseChats: conversation ids that skip the mention requirement
 *   homeChannel:   reserved
 *
 * Prerequisite: 企业内部应用 with the stream-mode bot capability (机器人 →
 * Stream 模式), published.
 */
import z from 'schemastery'
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('dingtalk')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-dingtalk'), z.object({
      clientId: z.string().default(''),
      clientSecret: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      requireMention: z.boolean().default(true),
      freeResponseChats: z.array(z.string()).default([]),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-dingtalk' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      clientId: (resolved.clientId && resolved.clientId.trim()) || process.env.DINGTALK_CLIENT_ID || '',
      clientSecret: (resolved.clientSecret && resolved.clientSecret.trim()) || process.env.DINGTALK_CLIENT_SECRET || '',
    }
  }

  let client = null
  /** chatId -> { url, expiresAt } — session webhooks expire after ~2h. */
  const sessionWebhooks = new Map()

  const adapter = {
    id: 'dingtalk',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 4000,
    },
    resolveConfig,

    async connect() {
      if (client) return
      const cfg = resolveConfig()
      if (!cfg.clientId || !cfg.clientSecret) {
        logger.warn('dingtalk: 未配置（settings messaging-dingtalk.clientId/clientSecret 或环境变量）')
        return
      }
      const c = new DWClient({ clientId: cfg.clientId, clientSecret: cfg.clientSecret })
      client = c
      c.registerCallbackListener(TOPIC_ROBOT, (message) => {
        handleMessage(message).catch((error) => logger.error(`dingtalk message failed: ${error.stack || error.message}`))
      })
      c.on && c.on('error', (error) => logger.error(`dingtalk stream error: ${error.message}`))
      await c.connect()
      adapter.connected = true
      logger.info('dingtalk connected (stream mode)')
    },

    async disconnect() {
      const c = client
      client = null
      adapter.connected = false
      if (c) {
        try {
          c.disconnect()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      const cached = sessionWebhooks.get(target.chatId)
      if (!cached || Date.now() >= cached.expiresAt) {
        throw new Error(`dingtalk: session webhook expired for ${target.chatId}（需要对方先发消息刷新）`)
      }
      const res = await fetch(cached.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'DSH Agent', text } }),
      })
      if (!res.ok) throw new Error(`dingtalk session webhook failed: HTTP ${res.status}`)
      return {}
    },

    async sendTyping() { /* DingTalk has no typing */ },

    async sendMedia() {
      throw new Error('dingtalk: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'dingtalk-chat', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.clientId && initial.clientSecret) {
    adapter.connect().catch((error) => logger.error(`dingtalk connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('dingtalk: 未配置，等待配置（settings messaging-dingtalk）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.clientId && next.clientSecret && !client) {
        adapter.connect().catch((error) => logger.error(`dingtalk connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Normalize one DingTalk robot message into a messaging-core inbound event. */
  async function handleMessage(envelope) {
    const m = envelope && envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope
    if (!m || !m.conversationId || !m.msgId) return
    const chatId = String(m.conversationId)
    const senderId = String(m.senderStaffId || m.senderId || '')
    if (!senderId) return

    // Cache the session webhook for replies (expires ~2h).
    if (m.sessionWebhook && /^https:\/\/(?:api|oapi)\.dingtalk\.com\//.test(m.sessionWebhook)) {
      const expiresIn = Number(m.sessionWebhookExpiredTime || 0)
      sessionWebhooks.set(chatId, { url: String(m.sessionWebhook), expiresAt: expiresIn > 0 ? expiresIn : Date.now() + 2 * 3600 * 1000 })
      if (sessionWebhooks.size > 500) sessionWebhooks.delete(sessionWebhooks.keys().next().value)
    }

    let text = ''
    if (m.msgtype === 'text' && m.text) text = String(m.text.content || '').trim()
    if (!text) return

    const isGroup = String(m.conversationType || '').toLowerCase().includes('group')
    const cfg = resolveConfig()
    if (isGroup) {
      const free = cfg.freeResponseChats && cfg.freeResponseChats.includes(chatId)
      const atBot = Number(m.isInAtList) === 1
      if (!free && cfg.requireMention !== false && !atBot) return
    }

    await ctx.messaging.handleInbound('dingtalk', {
      platform: 'dingtalk',
      chatKey: `dingtalk:${chatId}`,
      chatId,
      userId: senderId,
      userName: m.senderNick || senderId,
      text,
      raw: m,
    })
  }
}
