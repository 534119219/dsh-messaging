/**
 * platform-mattermost — Mattermost messaging adapter for DSH.
 *
 * WebSocket event stream (wss://<host>/api/v4/websocket, Bearer token) for
 * inbound posts + REST API (/api/v4) for outbound. Replies stay inside the
 * originating thread (root_id). Channel messages require a bot @mention
 * unless the channel is in freeResponseChannels.
 *
 * Configuration (settings namespace `messaging-mattermost`):
 *   url:        server base URL, e.g. https://mattermost.example.com (env: MATTERMOST_URL)
 *   token:      personal access token or bot token (env: MATTERMOST_TOKEN)
 *   allowedUsers: user ids allowed to talk to the bot
 *   allowAll:    true to accept everyone (dev only)
 *   requireMention: respond to @mentions in channels (default true)
 *   freeResponseChannels: channel ids that do not require a mention
 *   homeChannel: default channel for cron/notification delivery (reserved)
 */
import z from 'schemastery'
import WebSocket from 'ws'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('mattermost')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-mattermost'), z.object({
      url: z.string().default(''),
      token: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      requireMention: z.boolean().default(true),
      freeResponseChannels: z.array(z.string()).default([]),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-mattermost' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      url: (resolved.url && resolved.url.trim().replace(/\/+$/, '')) || process.env.MATTERMOST_URL || '',
      token: (resolved.token && resolved.token.trim()) || process.env.MATTERMOST_TOKEN || '',
    }
  }

  let ws = null
  let botUserId = null
  let botUsername = null
  let disposed = false
  let reconnectTimer = null
  let retries = 0

  const adapter = {
    id: 'mattermost',
    connected: false,
    capabilities: {
      streaming: false,
      typing: true,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 4000,
    },
    resolveConfig,

    async connect() {
      if (ws || disposed) return
      const cfg = resolveConfig()
      if (!cfg.url || !cfg.token) {
        logger.warn('mattermost: 未配置（settings messaging-mattermost.url/token 或环境变量）')
        return
      }
      // Identify the bot (users/me) for self-filtering and mention gating.
      try {
        const me = await api('GET', '/users/me')
        botUserId = me.id
        botUsername = me.username
      } catch (error) {
        logger.warn(`mattermost users/me failed: ${error.message}`)
      }
      const wsUrl = cfg.url.replace(/^http/, 'ws') + '/api/v4/websocket'
      const s = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${cfg.token}` } })
      ws = s
      s.on('open', () => {
        retries = 0
        adapter.connected = true
        logger.info(`mattermost connected (${cfg.url}, bot ${botUsername || botUserId})`)
      })
      s.on('message', (raw) => {
        handleEvent(raw).catch((error) => logger.error(`mattermost event failed: ${error.stack || error.message}`))
      })
      s.on('close', () => {
        adapter.connected = false
        ws = null
        if (!disposed) scheduleReconnect()
      })
      s.on('error', (error) => logger.warn(`mattermost ws error: ${error.message}`))
    },

    async disconnect() {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
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
      const body = { channel_id: target.chatId, message: text }
      if (target.threadId) body.root_id = target.threadId
      await api('POST', '/posts', body)
      return {}
    },

    async sendTyping(target) {
      if (!botUserId) return
      try {
        await api('POST', `/users/${botUserId}/typing`, { channel_id: target.chatId })
      } catch { /* best-effort */ }
    },

    async sendMedia() {
      throw new Error('mattermost: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      const channel = await api('GET', `/channels/${chatId}`)
      return { name: channel.name || String(chatId), type: channel.type || 'channel', chatId: String(chatId) }
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
    logger.warn(`mattermost disconnected, reconnect in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      adapter.connect().catch((error) => logger.error(`mattermost reconnect failed: ${error.message}`))
    }, delay)
  }

  const initial = resolveConfig()
  if (initial.url && initial.token) {
    adapter.connect().catch((error) => logger.error(`mattermost connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('mattermost: 未配置，等待配置（settings messaging-mattermost）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.url && next.token && !ws) {
        adapter.connect().catch((error) => logger.error(`mattermost connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Mattermost REST call against /api/v4. */
  async function api(method, path, body) {
    const cfg = resolveConfig()
    const res = await fetch(`${cfg.url}/api/v4/${path.replace(/^\//, '')}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 204) return undefined
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`mattermost ${method} ${path} failed: HTTP ${res.status} ${data.message || ''}`.trim())
    return data
  }

  /** Normalize one WS event into a messaging-core inbound event. */
  async function handleEvent(raw) {
    let payload
    try {
      payload = JSON.parse(String(raw))
    } catch {
      return
    }
    if (payload.event !== 'posted') return
    let post
    try {
      post = typeof payload.data.post === 'string' ? JSON.parse(payload.data.post) : payload.data.post
    } catch {
      return
    }
    if (!post || !post.id || !post.channel_id || !post.user_id) return
    if (post.type) return // system posts
    if (botUserId && post.user_id === botUserId) return
    if (post.delete_at && post.delete_at > 0) return
    const message = (post.message || '').trim()
    if (!message) return
    const channelType = payload.data.channel_type || ''
    const cfg = resolveConfig()

    if (channelType === 'O' || channelType === 'P') {
      const free = cfg.freeResponseChannels && cfg.freeResponseChannels.includes(post.channel_id)
      const mentioned = botUsername ? new RegExp(`@${escapeRegExp(botUsername)}\\b`).test(message) : false
      if (!free && cfg.requireMention !== false && !mentioned) return
    }

    await ctx.messaging.handleInbound('mattermost', {
      platform: 'mattermost',
      chatKey: `mattermost:${post.channel_id}`,
      chatId: String(post.channel_id),
      threadId: String(post.root_id || post.id),
      userId: String(post.user_id),
      userName: post.user_id,
      text: message,
      raw: post,
    })
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
