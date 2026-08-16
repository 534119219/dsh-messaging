/**
 * platform-qq — QQ Bot API v2 messaging adapter for DSH.
 *
 * Official QQ Bot WebSocket Gateway (Discord-style protocol: Hello/heartbeat/
 * identify) for inbound C2C and group-@ messages; REST API for outbound.
 * Mirrors hermes-agent's qqbot adapter protocol.
 *
 * Configuration (settings namespace `messaging-qq`):
 *   appId:        QQ bot app id (env: QQ_APP_ID)
 *   clientSecret: QQ bot client secret (env: QQ_CLIENT_SECRET)
 *   allowedUsers: user openids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  reserved
 *
 * Prerequisite: register a bot on q.qq.com and enable the C2C/group message
 * intents for the app.
 */
import z from 'schemastery'
import WebSocket from 'ws'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const API_BASE = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
// Mirror the proven hermes-agent qqbot identify intent set: C2C/group-at +
// public guild + direct message + interaction. The gateway only pushes C2C
// single-chat events when the DIRECT_MESSAGE-class intents are subscribed.
const INTENTS = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26)

export function register(ctx) {
  const logger = ctx.logger('qq')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-qq'), z.object({
      appId: z.string().default(''),
      clientSecret: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      markdownSupport: z.boolean().default(true),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-qq' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      appId: (resolved.appId && resolved.appId.trim()) || process.env.QQ_APP_ID || '',
      clientSecret: (resolved.clientSecret && resolved.clientSecret.trim()) || process.env.QQ_CLIENT_SECRET || '',
      markdownSupport: resolved.markdownSupport !== false,
    }
  }

  /** Light markdown cleanup for the plain-text fallback (markers removed). */
  function stripMarkdownForText(text) {
    return String(text)
      .replace(/```[^\n]*\n[\s\S]*?```/g, (m) => m.replace(/^```[^\n]*\n/, '').replace(/```$/, '').trim())
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^>\s?/gm, '')
      .trim()
  }

  let ws = null
  let accessToken = null
  let tokenExpiresAt = 0
  let heartbeatTimer = null
  let seq = 0
  let disposed = false
  let reconnectTimer = null
  let retries = 0

  /** Live connection diagnostics, surfaced through /messaging/status. */
  const state = {
    wsState: 'idle',
    frames: 0,
    lastFrameAt: 0,
    dispatches: 0,
    lastDispatchAt: 0,
    lastError: '',
    lastDrop: '',
    lastSendError: '',
    reconnects: 0,
  }

  function detail() {
    const parts = [
      `ws=${state.wsState}`,
      `frames=${state.frames}`,
      `dispatches=${state.dispatches}`,
      `reconnects=${state.reconnects}`,
    ]
    if (state.lastFrameAt) parts.push(`lastFrame=${new Date(state.lastFrameAt).toTimeString().slice(0, 8)}`)
    if (state.lastDispatchAt) parts.push(`lastDispatch=${new Date(state.lastDispatchAt).toTimeString().slice(0, 8)}`)
    if (state.lastDrop) parts.push(`lastDrop=${state.lastDrop}`)
    if (state.lastSendError) parts.push(`sendErr=${state.lastSendError}`)
    if (state.lastError) parts.push(`err=${state.lastError}`)
    return parts.join(' ')
  }

  const adapter = {
    id: 'qq',
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
    detail,

    async connect() {
      if (ws || disposed) return
      const cfg = resolveConfig()
      if (!cfg.appId || !cfg.clientSecret) {
        logger.warn('qq: 未配置（settings messaging-qq.appId/clientSecret 或环境变量）')
        return
      }
      try {
        const token = await ensureToken()
        const gatewayUrl = await fetchGateway(token)
        const s = new WebSocket(gatewayUrl)
        ws = s
        state.wsState = 'open'
        state.lastError = ''
        s.on('open', () => {
          // Identify with the same intent set hermes-agent uses (proven to
          // receive C2C/group events for this app).
          s.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
              properties: { $os: 'windows', $browser: 'dsh-messaging', $device: 'dsh-messaging' },
            },
          }))
        })
        s.on('message', (raw) => {
          handleFrame(raw).catch((error) => logger.error(`qq frame failed: ${error.stack || error.message}`))
        })
        s.on('close', (code) => {
          stopHeartbeat()
          adapter.connected = false
          state.wsState = 'closed'
          ws = null
          if (code === 4009 || code === 4010 || code === 4011) seq = 0 // session invalid → full re-identify
          if (!disposed) scheduleReconnect()
        })
        s.on('error', (error) => {
          state.lastError = error.message
          logger.warn(`qq ws error: ${error.message}`)
        })
      } catch (error) {
        // A failed connect (token/gateway fetch) must not strand the adapter:
        // schedule a reconnect unless we are shutting down.
        state.lastError = error.message
        state.wsState = 'connect-failed'
        logger.error(`qq connect failed: ${error.message}`)
        if (!disposed) scheduleReconnect()
      }
    },

    async disconnect() {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      stopHeartbeat()
      const s = ws
      ws = null
      adapter.connected = false
      if (s) {
        try {
          s.close()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      const maxLen = 4000
      const msgSeq = Math.floor(Math.random() * 1e9)
      let path
      if (target.chatId.startsWith('group:')) path = `/v2/groups/${target.chatId.slice(6)}/messages`
      else if (target.chatId.startsWith('c2c:')) path = `/v2/users/${target.chatId.slice(4)}/messages`
      else throw new Error(`qq: unknown target ${target.chatId}`)
      // QQ native markdown (msg_type 2): bold/italic/lists/links render in the
      // client. Requires the 原生 MD (and 被动 MD for replies) permission on
      // q.qq.com; without it the API errors and we fall back to plain text.
      if (resolveConfig().markdownSupport) {
        try {
          const data = await api('POST', path, {
            msg_type: 2,
            msg_seq: msgSeq,
            markdown: { content: String(text).slice(0, maxLen) },
          })
          return { messageId: data && data.id ? String(data.id) : null }
        } catch (error) {
          state.lastSendError = `markdown failed (${error.message}), fell back to text`
          logger.warn(`qq markdown send failed, falling back to text: ${error.message}`)
        }
      }
      const data = await api('POST', path, {
        msg_type: 0,
        msg_seq: msgSeq,
        content: stripMarkdownForText(text).slice(0, maxLen),
      })
      return { messageId: data && data.id ? String(data.id) : null }
    },

    async sendTyping() { /* QQ input-notify unsupported in M0 */ },

    async sendMedia() {
      throw new Error('qq: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: chatId.startsWith('group:') ? 'group' : 'c2c', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  function scheduleReconnect() {
    const delay = Math.min(60000, 5000 * 2 ** retries)
    retries += 1
    state.reconnects += 1
    logger.warn(`qq disconnected, reconnect in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      adapter.connect().catch((error) => logger.error(`qq reconnect failed: ${error.message}`))
    }, delay)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const initial = resolveConfig()
  if (initial.appId && initial.clientSecret) {
    adapter.connect().catch((error) => logger.error(`qq connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('qq: 未配置，等待配置（settings messaging-qq）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.appId && next.clientSecret && !ws) {
        adapter.connect().catch((error) => logger.error(`qq connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Access token with expiry cache (refreshed 60s before expiration). */
  async function ensureToken() {
    const cfg = resolveConfig()
    if (accessToken && Date.now() / 1000 < tokenExpiresAt - 60) return accessToken
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.clientSecret }),
    })
    if (!res.ok) throw new Error(`qq token request failed: HTTP ${res.status}`)
    const data = await res.json()
    if (!data.access_token) throw new Error(`qq token response missing access_token: ${JSON.stringify(data).slice(0, 200)}`)
    accessToken = data.access_token
    tokenExpiresAt = Date.now() / 1000 + Number(data.expires_in || 7200)
    return accessToken
  }

  /** Gateway WebSocket URL. */
  async function fetchGateway(token) {
    const res = await fetch(`${API_BASE}/gateway`, { headers: { Authorization: `QQBot ${token}` } })
    if (!res.ok) throw new Error(`qq gateway request failed: HTTP ${res.status}`)
    const data = await res.json()
    if (!data.url) throw new Error(`qq gateway response missing url: ${JSON.stringify(data).slice(0, 200)}`)
    return data.url
  }

  /** QQ REST call against api.sgroup.qq.com. */
  async function api(method, path, body) {
    const token = await ensureToken()
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`qq ${method} ${path} failed: HTTP ${res.status} ${data.message || ''}`.trim())
    return data
  }

  /** Gateway frame dispatch: Hello → heartbeat; Dispatch → events. */
  async function handleFrame(raw) {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!frame || typeof frame.op !== 'number') return
    state.frames += 1
    state.lastFrameAt = Date.now()
    if (frame.op === 10) {
      // Hello: start heartbeating at the negotiated interval.
      const interval = frame.d && frame.d.heartbeat_interval ? Number(frame.d.heartbeat_interval) : 30000
      stopHeartbeat()
      heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: 1, d: seq }))
        }
      }, Math.max(5000, Math.floor(interval * 0.8)))
      adapter.connected = true
      state.wsState = 'ready'
      retries = 0
      logger.info('qq gateway connected')
      return
    }
    if (frame.op === 0) {
      if (typeof frame.s === 'number') seq = frame.s
      if (frame.t === 'C2C_MESSAGE_CREATE' || frame.t === 'GROUP_AT_MESSAGE_CREATE') {
        state.dispatches += 1
        state.lastDispatchAt = Date.now()
        logger.info(`qq dispatch ${frame.t} (dispatches=${state.dispatches})`)
        await handleMessage(frame.d, frame.t === 'GROUP_AT_MESSAGE_CREATE')
      }
    }
  }

  /** Normalize one C2C/group message into a messaging-core inbound event. */
  async function handleMessage(d, isGroup) {
    if (!d || typeof d !== 'object') return
    const msgId = String(d.id || d.msg_id || '')
    if (!msgId) {
      state.lastDrop = 'missing message id'
      logger.warn(`qq dispatch dropped: missing message id ${JSON.stringify(d || {}).slice(0, 300)}`)
      return
    }
    const author = d.author && typeof d.author === 'object' ? d.author : {}
    const openid = String(author.user_openid || author.id || '')
    const targetId = isGroup ? (d.group_openid || d.group_id) : openid
    if (!targetId) {
      state.lastDrop = isGroup ? 'missing group_openid' : 'missing author.user_openid'
      logger.warn(`qq dispatch dropped: no target id ${JSON.stringify(d || {}).slice(0, 300)}`)
      return
    }
    let text = String(d.content || '').trim()
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text)
        if (parsed && parsed.content) text = String(parsed.content).trim()
      } catch { /* plain text */ }
    }
    if (!text) {
      state.lastDrop = 'empty text content'
      logger.warn('qq dispatch dropped: empty text content')
      return
    }
    state.lastDrop = ''

    const chatId = isGroup ? `group:${targetId}` : `c2c:${targetId}`
    await ctx.messaging.handleInbound('qq', {
      platform: 'qq',
      chatKey: `qq:${chatId}`,
      chatId,
      userId: isGroup ? String(author.member_openid || openid) : openid,
      userName: openid,
      text,
      raw: d,
    })
  }
}
