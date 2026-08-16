/**
 * platform-matrix — Matrix messaging adapter for DSH.
 *
 * matrix-js-sdk sync loop; supports streaming edits (m.replace relations),
 * typing indicators, DM + room mention gating, and the shared allowlist
 * authorization provided by messaging-core.
 *
 * Configuration (settings namespace `messaging-matrix`):
 *   homeserver:   e.g. https://matrix.org (env: MATRIX_HOMESERVER)
 *   accessToken:  access token (env: MATRIX_ACCESS_TOKEN), OR
 *   user/password: login credentials (env: MATRIX_USER / MATRIX_PASSWORD)
 *   allowedUsers: array of matrix user ids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  default room id for cron/notification delivery (reserved)
 */
import z from 'schemastery'
import { createClient } from 'matrix-js-sdk'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('matrix')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-matrix'), z.object({
      homeserver: z.string().default(''),
      accessToken: z.string().role('secret').default(''),
      user: z.string().default(''),
      password: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-matrix' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      homeserver: (resolved.homeserver && resolved.homeserver.trim()) || process.env.MATRIX_HOMESERVER || '',
      accessToken: (resolved.accessToken && resolved.accessToken.trim()) || process.env.MATRIX_ACCESS_TOKEN || '',
      user: (resolved.user && resolved.user.trim()) || process.env.MATRIX_USER || '',
      password: (resolved.password && resolved.password.trim()) || process.env.MATRIX_PASSWORD || '',
    }
  }

  let client = null
  let myUserId = null

  const adapter = {
    id: 'matrix',
    connected: false,
    capabilities: {
      streaming: true,
      typing: true,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 40000,
    },
    resolveConfig,

    async connect() {
      if (client) return
      const cfg = resolveConfig()
      if (!cfg.homeserver || (!cfg.accessToken && !(cfg.user && cfg.password))) {
        logger.warn('matrix: 未配置（settings messaging-matrix.homeserver + accessToken 或 user/password）')
        return
      }
      const c = createClient({
        baseUrl: cfg.homeserver,
        ...(cfg.accessToken ? { accessToken: cfg.accessToken, userId: cfg.user || undefined } : {}),
      })
      client = c
      try {
        if (!cfg.accessToken) {
          await c.loginWithPassword(cfg.user, cfg.password)
        }
        myUserId = c.getUserId()
        c.on('Room.timeline', (event, room, toStartOfTimeline) => {
          handleTimelineEvent(event, room, toStartOfTimeline).catch((error) => logger.error(`matrix event failed: ${error.stack || error.message}`))
        })
        await c.startClient({ initialSyncLimit: 10 })
        adapter.connected = true
        logger.info(`matrix connected as ${myUserId}`)
      } catch (error) {
        // Failed connect must not leave the client behind (reconnect on
        // later settings change would be blocked).
        client = null
        myUserId = null
        throw error
      }
    },

    async disconnect() {
      const c = client
      client = null
      myUserId = null
      adapter.connected = false
      if (c) {
        try {
          c.stopClient()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!client) throw new Error('matrix: not connected')
      const result = await client.sendMessage(target.chatId, { msgtype: 'm.text', body: text })
      return { messageId: result && result.event_id ? String(result.event_id) : null }
    },

    async editMessage(target, messageId, text) {
      if (!client) throw new Error('matrix: not connected')
      await client.sendMessage(target.chatId, {
        msgtype: 'm.text',
        body: text,
        'm.new_content': { msgtype: 'm.text', body: text },
        'm.relates_to': { rel_type: 'm.replace', event_id: messageId },
      })
    },

    async sendTyping(target) {
      if (!client) return
      await client.sendTyping(target.chatId, true, 5000)
    },

    async sendMedia() {
      throw new Error('matrix: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      const room = client ? client.getRoom(chatId) : null
      return { name: room && room.name ? room.name : String(chatId), type: 'room', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.homeserver && (initial.accessToken || (initial.user && initial.password))) {
    adapter.connect().catch((error) => logger.error(`matrix connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('matrix: 未配置，等待配置（settings messaging-matrix）')
  }

  /** Normalize one Matrix timeline event into a messaging-core inbound event. */
  async function handleTimelineEvent(event, room, toStartOfTimeline) {
    if (!client || toStartOfTimeline) return
    if (event.getType() !== 'm.room.message') return
    const content = event.getContent()
    if (!content) return
    // Skip edits (m.replace) and state that already carries new_content.
    if (content['m.new_content']) return
    const relates = content['m.relates_to']
    if (relates && relates.rel_type === 'm.replace') return
    const msgtype = content.msgtype
    if (msgtype !== 'm.text' && msgtype !== 'm.notice') return
    const sender = event.getSender()
    if (!sender || sender === myUserId) return
    const body = typeof content.body === 'string' ? content.body.trim() : ''
    if (!body) return
    if (!room) return

    const isDM = room.getMyMembership && room.getMyMembership() === 'join' && (room.getJoinedMemberCount ? room.getJoinedMemberCount() <= 2 : false)
    let text = body
    if (!isDM) {
      const mention = text.includes(myUserId) || (myDisplayName() && text.includes(myDisplayName()))
      if (!mention) return
      text = text.replace(new RegExp(escapeRegExp(myUserId), 'g'), '').trim()
      const name = myDisplayName()
      if (name) text = text.replace(new RegExp(escapeRegExp(name), 'g'), '').trim()
    }
    if (!text) return

    await ctx.messaging.handleInbound('matrix', {
      platform: 'matrix',
      chatKey: `matrix:${room.roomId}`,
      chatId: String(room.roomId),
      userId: String(sender),
      userName: sender,
      text,
      raw: { event, content },
    })
  }

  function myDisplayName() {
    if (!client || !myUserId) return null
    const user = client.getUser(myUserId)
    return user && user.displayName ? user.displayName : null
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
