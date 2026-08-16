/**
 * platform-irc — IRC messaging adapter for DSH.
 *
 * irc-framework TCP client; channel + private-message support, nick-mention
 * gating in channels, automatic reconnect with exponential backoff, and the
 * shared allowlist authorization provided by messaging-core. No streaming or
 * typing (IRC has neither).
 *
 * Configuration (settings namespace `messaging-irc`):
 *   server:          IRC server host (env: IRC_SERVER)
 *   port:            port (default 6697)
 *   useTls:          TLS on/off (default true)
 *   nickname:        bot nickname (env: IRC_NICKNAME)
 *   channel:         home channel to join, e.g. "#general" (env: IRC_CHANNEL)
 *   serverPassword:  server password (optional)
 *   nickservPassword: NickServ password (optional)
 *   allowedUsers:    array of nicks allowed to talk to the bot
 *   allowAll:        true to accept everyone (dev only)
 *   homeChannel:     default target for cron/notification delivery (reserved)
 */
import z from 'schemastery'
import IRC from 'irc-framework'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function register(ctx) {
  const logger = ctx.logger('irc')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-irc'), z.object({
      server: z.string().default(''),
      port: z.number().default(6697),
      useTls: z.boolean().default(true),
      nickname: z.string().default('dsh-bot'),
      channel: z.string().default(''),
      serverPassword: z.string().default(''),
      nickservPassword: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-irc' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      server: (resolved.server && resolved.server.trim()) || process.env.IRC_SERVER || '',
      nickname: (resolved.nickname && resolved.nickname.trim()) || process.env.IRC_NICKNAME || 'dsh-bot',
      channel: (resolved.channel && resolved.channel.trim()) || process.env.IRC_CHANNEL || '',
    }
  }

  let conn = null
  let reconnectTimer = null
  let disposed = false
  let retries = 0

  const adapter = {
    id: 'irc',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 380,
    },
    resolveConfig,

    async connect() {
      if (conn || disposed) return
      const cfg = resolveConfig()
      if (!cfg.server) {
        logger.warn('irc: 未配置 server（settings messaging-irc.server 或 IRC_SERVER）')
        return
      }
      const c = new IRC.Client()
      conn = c
      c.connect({
        host: cfg.server,
        port: cfg.port,
        tls: cfg.useTls,
        password: cfg.serverPassword || undefined,
        nick: cfg.nickname,
      })
      c.on('registered', () => {
        retries = 0
        adapter.connected = true
        logger.info(`irc connected as ${cfg.nickname} on ${cfg.server}`)
        if (cfg.nickservPassword) c.say('NickServ', `IDENTIFY ${cfg.nickservPassword}`)
        if (cfg.channel) c.join(cfg.channel)
      })
      c.on('message', (evt) => {
        handleMessage(evt).catch((error) => logger.error(`irc message failed: ${error.stack || error.message}`))
      })
      c.on('close', () => {
        adapter.connected = false
        conn = null
        if (!disposed) scheduleReconnect()
      })
    },

    async disconnect() {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const c = conn
      conn = null
      adapter.connected = false
      if (c) {
        try {
          c.quit('bye')
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!conn) throw new Error('irc: not connected')
      const name = target.chatId.startsWith('pm:') ? target.chatId.slice(3) : target.chatId
      conn.say(name, text)
      return {}
    },

    async sendTyping() { /* IRC has no typing */ },

    async sendMedia() {
      throw new Error('irc: media unsupported')
    },

    async getChatInfo(chatId) {
      const name = chatId.startsWith('pm:') ? chatId.slice(3) : chatId
      return { name, type: chatId.startsWith('pm:') ? 'pm' : 'channel', chatId }
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
    logger.warn(`irc disconnected, reconnect in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      adapter.connect().catch((error) => logger.error(`irc reconnect failed: ${error.message}`))
    }, delay)
  }

  const initial = resolveConfig()
  if (initial.server) {
    adapter.connect().catch((error) => logger.error(`irc connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('irc: 未配置 server，等待配置（settings messaging-irc.server）')
  }

  /** Normalize one IRC message event into a messaging-core inbound event. */
  async function handleMessage(evt) {
    if (!evt || !evt.nick || !evt.message) return
    const cfg = resolveConfig()
    if (evt.nick === cfg.nickname) return
    if (evt.message.startsWith('\x01')) return // CTCP

    const isPrivate = evt.target === cfg.nickname
    let text = evt.message
    if (!isPrivate) {
      const match = text.match(new RegExp(`^${escapeRegExp(cfg.nickname)}[\\s,:]`))
      if (!match) return
      text = text.slice(match[0].length).trim()
    }
    if (!text) return

    await ctx.messaging.handleInbound('irc', {
      platform: 'irc',
      chatKey: isPrivate ? `irc:pm:${evt.nick}` : `irc:${evt.target}`,
      chatId: isPrivate ? `pm:${evt.nick}` : String(evt.target),
      userId: String(evt.nick),
      userName: evt.nick,
      text,
      raw: evt,
    })
  }
}
