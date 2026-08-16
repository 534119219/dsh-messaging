/**
 * platform-bluebubbles — BlueBubbles iMessage adapter for DSH.
 *
 * Talks to a local BlueBubbles server (macOS + BlueBubbles app + helper):
 *   - outbound: POST /api/v1/message/text { chatGuid, tempGuid, message }
 *     (server password passed as ?password= query, mirroring hermes),
 *   - inbound: BlueBubbles webhook events (new-message / updated-message)
 *     on the shared listener at /bluebubbles-webhook; the webhook is
 *     registered with the BlueBubbles server via POST /api/v1/webhook,
 *     with the password embedded in the URL (the webhook API cannot send
 *     custom headers).
 *
 * Configuration (settings namespace `messaging-bluebubbles`):
 *   serverUrl:     e.g. http://127.0.0.1:1234 (macOS BlueBubbles server)
 *   password:      BlueBubbles server password
 *   webhookUrl:    URL the BlueBubbles server can reach on this machine,
 *                  e.g. http://192.168.1.10:8765/bluebubbles-webhook
 *                  (empty = print the URL to register manually)
 *   allowedUsers:  chat identifiers/GUIDs allowed to talk to the bot
 *   allowAll:      true to accept everyone (dev only)
 *   homeChannel:   reserved
 */
import z from 'schemastery'
import { randomUUID } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const MESSAGE_EVENTS = new Set(['new-message', 'message', 'updated-message'])

export function register(ctx) {
  const logger = ctx.logger('bluebubbles')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-bluebubbles'), z.object({
      serverUrl: z.string().default(''),
      password: z.string().role('secret').default(''),
      webhookUrl: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-bluebubbles' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      serverUrl: (resolved.serverUrl && resolved.serverUrl.trim().replace(/\/+$/, '')) || process.env.BLUEBUBBLES_SERVER_URL || '',
      password: (resolved.password && resolved.password.trim()) || process.env.BLUEBUBBLES_PASSWORD || '',
    }
  }

  let unregisterWebhook = null
  let registeredWebhook = false

  const adapter = {
    id: 'bluebubbles',
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
      if (!cfg.serverUrl || !cfg.password) {
        logger.warn('bluebubbles: 未配置（settings messaging-bluebubbles.serverUrl/password）')
        return
      }
      // Health check.
      await api(cfg, 'GET', '/api/v1/ping')
      const info = await api(cfg, 'GET', '/api/v1/server/info')
      const data = (info && info.data) || {}
      logger.info(`bluebubbles connected (private_api=${Boolean(data.private_api)}, helper=${Boolean(data.helper_connected)})`)

      unregisterWebhook = ctx.messaging.registerWebhook('/bluebubbles-webhook', (h) => handleWebhook(cfg, h))
      adapter.connected = true

      // Register the webhook with the BlueBubbles server (password in URL —
      // its webhook API cannot send custom headers).
      if (cfg.webhookUrl) {
        try {
          const existing = await api(cfg, 'GET', '/api/v1/webhook')
          const list = existing && existing.data ? existing.data : []
          const found = (Array.isArray(list) ? list : []).some((w) => w && (w.url || '').startsWith(cfg.webhookUrl.split('?')[0]))
          if (!found) {
            await api(cfg, 'POST', '/api/v1/webhook', {
              url: `${cfg.webhookUrl}?password=${encodeURIComponent(cfg.password)}`,
              events: ['new-message', 'updated-message'],
            })
            logger.info(`bluebubbles webhook registered: ${cfg.webhookUrl}`)
          } else {
            logger.info('bluebubbles webhook already registered')
          }
          registeredWebhook = true
        } catch (error) {
          logger.warn(`bluebubbles webhook registration failed: ${error.message}（可在 BlueBubbles 中手动注册）`)
        }
      } else {
        logger.warn('bluebubbles: webhookUrl 未配置，请在 BlueBubbles 中手动注册 webhook（指向本机 /bluebubbles-webhook，密码放入 URL query 或 x-password 头）')
      }
    },

    async disconnect() {
      if (unregisterWebhook) {
        try {
          unregisterWebhook()
        } catch { /* ignore */ }
        unregisterWebhook = null
      }
      registeredWebhook = false
      adapter.connected = false
    },

    async send(target, text) {
      const cfg = resolveConfig()
      let guid = target.chatId
      if (!guid.includes(';')) {
        // Not a raw GUID: resolve the chat, or create a new one for an address.
        const resolved = await resolveChatGuid(cfg, guid)
        if (!resolved) {
          if (guid.includes('@') || /^\+\d+/.test(guid)) {
            await api(cfg, 'POST', '/api/v1/chat/new', { addresses: [guid], message: text, tempGuid: `temp-${Date.now()}` })
            return {}
          }
          throw new Error(`bluebubbles: chat not found for ${guid}`)
        }
        guid = resolved
      }
      const payload = { chatGuid: guid, tempGuid: `temp-${Date.now()}`, message: text }
      const res = await api(cfg, 'POST', '/api/v1/message/text', payload)
      const data = (res && res.data) || {}
      return { messageId: data.guid || data.messageGuid || null }
    },

    async sendTyping() { /* BlueBubbles typing unsupported in M0 */ },

    async sendMedia() {
      throw new Error('bluebubbles: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'imessage', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.serverUrl && initial.password) {
    adapter.connect().catch((error) => logger.error(`bluebubbles connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('bluebubbles: 未配置，等待配置（settings messaging-bluebubbles）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.serverUrl && next.password && !unregisterWebhook) {
        adapter.connect().catch((error) => logger.error(`bluebubbles connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** BlueBubbles REST call with password query auth. */
  async function api(cfg, method, path, body) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${cfg.serverUrl}${path}${sep}password=${encodeURIComponent(cfg.password)}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`bluebubbles ${method} ${path} failed: HTTP ${res.status}`)
    return res.json().catch(() => ({}))
  }

  /** Resolve an address/identifier to a chat GUID (mirrors hermes). */
  async function resolveChatGuid(cfg, target) {
    try {
      const payload = await api(cfg, 'POST', '/api/v1/chat/query', { limit: 100, offset: 0 })
      for (const chat of (payload && payload.data) || []) {
        const guid = chat.guid || chat.chatGuid
        const identifier = chat.chatIdentifier || chat.identifier
        if (identifier === target && guid) return guid
      }
    } catch { /* ignore */ }
    return null
  }

  /** BlueBubbles webhook: verify password, dispatch message events. */
  async function handleWebhook(cfg, { url, headers, raw, res }) {
    const token = url.searchParams.get('password')
      || headers['x-password']
      || headers['x-guid']
      || headers['x-bluebubbles-guid']
    if (String(token || '') !== cfg.password) {
      res.writeHead(401)
      res.end()
      return
    }
    let payload
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      const form = new URLSearchParams(raw.toString('utf8'))
      const str = form.get('payload') || form.get('data') || form.get('message') || ''
      try {
        payload = str ? JSON.parse(str) : {}
      } catch {
        payload = {}
      }
    }
    res.writeHead(200)
    res.end('ok')
    const eventType = String(payload.type || payload.event || '')
    if (eventType && !MESSAGE_EVENTS.has(eventType)) return
    const record = payload.record || payload
    if (!record || typeof record !== 'object') return
    if (record.isFromMe || record.fromMe || record.is_from_me) return
    if (record.associatedMessageType) return // tapbacks
    const text = String(record.text || record.message || record.body || '').trim()
    if (!text) return
    const chatGuid = String(record.chatGuid || payload.chatGuid || '')
    if (!chatGuid) return
    const hasMedia = Array.isArray(record.attachments) && record.attachments.length > 0
    const finalText = hasMedia ? `${text}\n[（附带 ${record.attachments.length} 个附件，当前版本不解析媒体内容）]` : text

    await ctx.messaging.handleInbound('bluebubbles', {
      platform: 'bluebubbles',
      chatKey: `bluebubbles:${chatGuid}`,
      chatId: chatGuid,
      userId: chatGuid,
      userName: chatGuid,
      text: finalText,
      raw: record,
    })
  }
}
