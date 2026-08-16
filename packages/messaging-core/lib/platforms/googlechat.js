/**
 * platform-googlechat — Google Chat messaging adapter for DSH.
 *
 * Webhook route /google-chat on the messaging-core shared listener. Inbound
 * events are authenticated by verifying the Google-issued JWT (Bearer) with
 * the issuer's public keys (JWKS, cached per issuer). Outbound messages are
 * sent with a service-account JWT (google-auth-library) to
 * spaces.messages.create. Group rooms require an @mention.
 *
 * Configuration (settings namespace `messaging-googlechat`):
 *   serviceAccountJson: service account key JSON (env: GOOGLE_CHAT_SERVICE_ACCOUNT_JSON)
 *   botDisplayName:     bot display name used for room mention gating
 *   allowedUsers:       sender names ("users/...") allowed to talk to the bot
 *   allowAll:           true to accept everyone (dev only)
 *   homeChannel:        reserved
 *
 * Prerequisite: Google Cloud project with the Chat API enabled; the app's
 * connection endpoint points at <publicUrl>/google-chat.
 */
import z from 'schemastery'
import { JWT } from 'google-auth-library'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('googlechat')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-googlechat'), z.object({
      serviceAccountJson: z.string().role('secret').default(''),
      botDisplayName: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-googlechat' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      serviceAccountJson: (resolved.serviceAccountJson && resolved.serviceAccountJson.trim()) || process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON || '',
    }
  }

  function serviceAccount() {
    const cfg = resolveConfig()
    if (!cfg.serviceAccountJson) return null
    try {
      const parsed = JSON.parse(cfg.serviceAccountJson)
      if (parsed.client_email && parsed.private_key) return parsed
    } catch (error) {
      logger.warn(`googlechat: serviceAccountJson 解析失败: ${error.message}`)
    }
    return null
  }

  let unregisterWebhook = null
  let authClient = null
  /** iss -> remote JWKS (cached). */
  const jwksSets = new Map()

  const adapter = {
    id: 'googlechat',
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
      const sa = serviceAccount()
      if (!sa) {
        logger.warn('googlechat: 未配置 serviceAccountJson（settings messaging-googlechat 或环境变量）')
        return
      }
      authClient = new JWT({
        email: sa.client_email,
        key: sa.private_key,
        scopes: ['https://www.googleapis.com/auth/chat.bot'],
      })
      unregisterWebhook = ctx.messaging.registerWebhook('/google-chat', handleWebhook)
      adapter.connected = true
      logger.info('googlechat webhook ready at /google-chat')
    },

    async disconnect() {
      if (unregisterWebhook) {
        try {
          unregisterWebhook()
        } catch { /* ignore */ }
        unregisterWebhook = null
      }
      authClient = null
      adapter.connected = false
    },

    async send(target, text) {
      if (!authClient) throw new Error('googlechat: not connected')
      const res = await authClient.request({
        url: `https://chat.googleapis.com/v1/${target.chatId}/messages`,
        method: 'POST',
        data: { text },
      })
      return { messageId: res.data && res.data.name ? String(res.data.name) : null }
    },

    async sendTyping() { /* Google Chat typing unsupported in M0 */ },

    async sendMedia() {
      throw new Error('googlechat: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'space', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.serviceAccountJson) {
    adapter.connect().catch((error) => logger.error(`googlechat connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('googlechat: 未配置，等待配置（settings messaging-googlechat.serviceAccountJson）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.serviceAccountJson && !unregisterWebhook) {
        adapter.connect().catch((error) => logger.error(`googlechat connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Verify the Google-issued JWT and dispatch the Chat event. */
  async function handleWebhook({ headers, raw, res }) {
    const auth = headers.authorization
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token) {
      res.writeHead(401)
      res.end()
      return
    }
    try {
      await verifyChatToken(token)
    } catch (error) {
      logger.warn(`googlechat token verification failed: ${error.message}`)
      res.writeHead(401)
      res.end()
      return
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
    handleEvent(payload).catch((error) => logger.error(`googlechat event failed: ${error.stack || error.message}`))
  }

  /** Verify signature/issuer/expiry of a Chat push-event JWT via JWKS. */
  async function verifyChatToken(token) {
    // Decode the unverified payload to find the issuer, then verify with the
    // issuer's public keys (cached per issuer).
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('malformed token')
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const iss = claims.iss
    if (!iss) throw new Error('missing iss')
    let set = jwksSets.get(iss)
    if (!set) {
      set = createRemoteJWKSet(new URL(`https://www.googleapis.com/service_accounts/v1/jwk/${encodeURIComponent(iss)}`))
      jwksSets.set(iss, set)
    }
    const { payload } = await jwtVerify(token, set, { algorithms: ['RS256'] })
    if (payload.aud && payload.aud !== 'chat.googleapis.com') {
      throw new Error(`unexpected aud ${payload.aud}`)
    }
  }

  /** Normalize one Google Chat event into a messaging-core inbound event. */
  async function handleEvent(payload) {
    if (!payload || payload.type !== 'MESSAGE' || !payload.message) return
    const message = payload.message
    const space = message.space
    const sender = message.sender
    if (!space || !space.name || !sender || !sender.name) return
    const chatId = String(space.name)
    const textRaw = String(message.text || '').trim()
    if (!textRaw) return

    let text = textRaw
    if (space.type === 'ROOM') {
      const cfg = resolveConfig()
      const mentioned = cfg.botDisplayName ? text.includes(`@${cfg.botDisplayName}`) : Array.isArray(message.annotations) && message.annotations.length > 0
      if (!mentioned) return
      text = text.replace(/^@\S+\s*/, '').trim()
    }
    if (!text) return

    await ctx.messaging.handleInbound('googlechat', {
      platform: 'googlechat',
      chatKey: `googlechat:${chatId}`,
      chatId,
      userId: String(sender.name),
      userName: sender.displayName || String(sender.name),
      text,
      raw: payload,
    })
  }
}
