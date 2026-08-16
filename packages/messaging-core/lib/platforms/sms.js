/**
 * platform-sms — SMS messaging adapter for DSH (Twilio).
 *
 * Webhook route /sms on the messaging-core shared listener. Twilio signature
 * verification is optional (default off: the signature covers the full public
 * URL Twilio has configured, which is awkward behind proxies — enable it when
 * the callback URL is stable). Outbound goes through the Twilio REST API.
 *
 * Configuration (settings namespace `messaging-sms`):
 *   accountSid:  Twilio Account SID (env: TWILIO_ACCOUNT_SID)
 *   authToken:   Twilio Auth Token (env: TWILIO_AUTH_TOKEN)
 *   phoneNumber: the agent's Twilio phone number (env: TWILIO_PHONE_NUMBER)
 *   allowedUsers: sender phone numbers allowed to talk to the bot
 *   allowAll:     true to accept anyone (dev only)
 *   validateSignature: verify X-Twilio-Signature (default false, see above)
 *   homeChannel:  reserved
 */
import z from 'schemastery'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('sms')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-sms'), z.object({
      accountSid: z.string().default(''),
      authToken: z.string().role('secret').default(''),
      phoneNumber: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      validateSignature: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-sms' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      accountSid: (resolved.accountSid && resolved.accountSid.trim()) || process.env.TWILIO_ACCOUNT_SID || '',
      authToken: (resolved.authToken && resolved.authToken.trim()) || process.env.TWILIO_AUTH_TOKEN || '',
      phoneNumber: (resolved.phoneNumber && resolved.phoneNumber.trim()) || process.env.TWILIO_PHONE_NUMBER || '',
    }
  }

  let unregisterWebhook = null

  const adapter = {
    id: 'sms',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 1600,
    },
    resolveConfig,

    async connect() {
      if (unregisterWebhook) return
      const cfg = resolveConfig()
      if (!cfg.accountSid || !cfg.authToken || !cfg.phoneNumber) {
        logger.warn('sms: 未配置（settings messaging-sms.accountSid/authToken/phoneNumber 或环境变量）')
        return
      }
      unregisterWebhook = ctx.messaging.registerWebhook('/sms', handleWebhook)
      adapter.connected = true
      logger.info('sms webhook ready at /sms')
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
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: cfg.phoneNumber, To: target.chatId, Body: text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`twilio send failed: HTTP ${res.status} ${data.message || ''}`.trim())
      return { messageId: data.sid ? String(data.sid) : null }
    },

    async sendTyping() { /* SMS has no typing */ },

    async sendMedia() {
      throw new Error('sms: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'phone', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.accountSid && initial.authToken && initial.phoneNumber) {
    adapter.connect().catch((error) => logger.error(`sms connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('sms: 未配置，等待配置（settings messaging-sms）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.accountSid && next.authToken && next.phoneNumber && !unregisterWebhook) {
        adapter.connect().catch((error) => logger.error(`sms connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Twilio webhook: optional signature check, then dispatch. */
  async function handleWebhook({ raw, url, headers, res }) {
    const cfg = resolveConfig()
    if (cfg.validateSignature) {
      const signature = headers['x-twilio-signature']
      const expected = createHmac('sha1', cfg.authToken)
        .update(url.toString() + raw.toString('utf8'))
        .digest('base64')
      if (!signature || !safeEqual(String(signature), expected)) {
        res.writeHead(401)
        res.end()
        return
      }
    }
    const body = new URLSearchParams(raw.toString('utf8'))
    const from = body.get('From')
    const to = body.get('To')
    const text = (body.get('Body') || '').trim()
    res.writeHead(200)
    res.end()
    if (!from || !to || !text) return
    if (cfg.phoneNumber && to.replace(/[^\d]/g, '') !== cfg.phoneNumber.replace(/[^\d]/g, '')) return // not for us
    if (from.replace(/[^\d]/g, '') === cfg.phoneNumber.replace(/[^\d]/g, '')) return // self

    await ctx.messaging.handleInbound('sms', {
      platform: 'sms',
      chatKey: `sms:${from}`,
      chatId: String(from),
      userId: String(from),
      userName: from,
      text,
      raw: { from, to, body: text, sid: body.get('MessageSid') },
    })
  }
}

function safeEqual(a, b) {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}
