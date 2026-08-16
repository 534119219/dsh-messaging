/**
 * platform-whatsappcloud — WhatsApp Cloud API messaging adapter for DSH.
 *
 * Official Meta WhatsApp Business Platform: webhook route /whatsapp-cloud on
 * the messaging-core shared listener (verify-token handshake +
 * X-Hub-Signature-256 HMAC), outbound via the Graph API. DMs only in M0
 * (group messages are logged and skipped).
 *
 * Configuration (settings namespace `messaging-whatsappcloud`):
 *   token:       permanent access token from the Meta app (secret)
 *   appSecret:   Meta app secret for webhook signature (secret)
 *   verifyToken: your chosen webhook verify token
 *   allowedUsers: phone numbers allowed to talk to the bot
 *   allowAll:     true to accept anyone (dev only)
 *   validateSignature: verify X-Hub-Signature-256 (default true)
 *   homeChannel:  reserved
 *
 * Prerequisites: Meta Business account + WhatsApp Business phone number;
 * the app's webhook must be pointed at <publicUrl>/whatsapp-cloud with
 * subscription "messages".
 */
import z from 'schemastery'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const GRAPH_VERSION = 'v21.0'

export function register(ctx) {
  const logger = ctx.logger('whatsappcloud')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-whatsappcloud'), z.object({
      token: z.string().role('secret').default(''),
      appSecret: z.string().role('secret').default(''),
      verifyToken: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      validateSignature: z.boolean().default(true),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-whatsappcloud' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      token: (resolved.token && resolved.token.trim()) || process.env.WHATSAPP_CLOUD_TOKEN || '',
      appSecret: (resolved.appSecret && resolved.appSecret.trim()) || process.env.WHATSAPP_CLOUD_APP_SECRET || '',
    }
  }

  let unregisterWebhook = null
  /** chatId (phone) -> phone_number_id from the webhook metadata. */
  const phoneNumberIds = new Map()

  const adapter = {
    id: 'whatsappcloud',
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
      if (unregisterWebhook) return
      const cfg = resolveConfig()
      if (!cfg.token || !cfg.appSecret) {
        logger.warn('whatsappcloud: 未配置（settings messaging-whatsappcloud.token/appSecret）')
        return
      }
      unregisterWebhook = ctx.messaging.registerWebhook('/whatsapp-cloud', handleWebhook)
      adapter.connected = true
      logger.info('whatsappcloud webhook ready at /whatsapp-cloud')
    },

    async disconnect() {
      if (unregisterWebhook) {
        try {
          unregisterWebhook()
        } catch { /* ignore */ }
        unregisterWebhook = null
      }
      adapter.connected = false
    },

    async send(target, text) {
      const cfg = resolveConfig()
      const phoneNumberId = phoneNumberIds.get(target.chatId)
      if (!phoneNumberId) throw new Error('whatsappcloud: unknown phone_number_id for this chat (wait for an inbound message first)')
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: target.chatId, type: 'text', text: { body: text } }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`whatsapp graph send failed: HTTP ${res.status} ${data.error && data.error.message ? data.error.message : ''}`.trim())
      return { messageId: data.messages && data.messages[0] ? String(data.messages[0].id) : null }
    },

    async sendTyping() { /* Cloud API has no typing */ },

    async sendMedia() {
      throw new Error('whatsappcloud: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'dm', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.token && initial.appSecret) {
    adapter.connect().catch((error) => logger.error(`whatsappcloud connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('whatsappcloud: 未配置，等待配置（settings messaging-whatsappcloud）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.token && next.appSecret && !unregisterWebhook) {
        adapter.connect().catch((error) => logger.error(`whatsappcloud connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Meta webhook: GET = verification handshake, POST = message delivery. */
  async function handleWebhook({ url, raw, headers, res }) {
    const cfg = resolveConfig()
    if (url.searchParams.get('hub.mode') === 'subscribe') {
      if (url.searchParams.get('hub.verify_token') === cfg.verifyToken) {
        res.writeHead(200)
        res.end(url.searchParams.get('hub.challenge') || '')
      } else {
        res.writeHead(403)
        res.end()
      }
      return
    }
    if (cfg.validateSignature !== false) {
      const signature = headers['x-hub-signature-256']
      const expected = 'sha256=' + createHmac('sha256', cfg.appSecret).update(raw).digest('hex')
      if (!signature || !safeEqual(String(signature), expected)) {
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
    handlePayload(payload).catch((error) => logger.error(`whatsappcloud webhook failed: ${error.stack || error.message}`))
  }

  /** Normalize one Meta webhook payload into inbound events (DMs only). */
  async function handlePayload(payload) {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value
        if (!value || !value.messages || !Array.isArray(value.messages)) continue
        const phoneNumberId = value.metadata && value.metadata.phone_number_id ? String(value.metadata.phone_number_id) : null
        for (const message of value.messages) {
          if (!message || !message.from || !message.id) continue
          if (message.group_id) {
            logger.info(`whatsappcloud: group message skipped (M0: DMs only)`)
            continue
          }
          const text = message.type === 'text' && message.text ? String(message.text.body || '').trim() : ''
          if (!text) continue
          const from = String(message.from).replace(/[^\d]/g, '')
          if (phoneNumberId) phoneNumberIds.set(from, phoneNumberId)
          await ctx.messaging.handleInbound('whatsappcloud', {
            platform: 'whatsappcloud',
            chatKey: `whatsappcloud:${from}`,
            chatId: from,
            userId: from,
            userName: from,
            text,
            raw: message,
          })
        }
      }
    }
  }
}

function safeEqual(a, b) {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}
