/**
 * platform-discord — Discord messaging adapter for DSH.
 *
 * discord.js gateway client; supports streaming edits (Discord renders
 * markdown natively), typing indicators, text + attachment sends, DM +
 * guild mention gating, and the shared allowlist authorization provided by
 * messaging-core.
 *
 * Configuration (settings namespace `messaging-discord`, or env fallback):
 *   token:        bot token from the Discord Developer Portal (env: DISCORD_BOT_TOKEN)
 *   allowedUsers: array of user ids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  default channel id for cron/notification delivery (reserved)
 *
 * Privileged gateway intents required in the Developer Portal:
 *   MESSAGE CONTENT (for message text), plus Server Members if you gate on roles.
 */
import z from 'schemastery'
import { ChannelType, Client, GatewayIntentBits, MessageType } from 'discord.js'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('discord')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-discord'), z.object({
      token: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-discord' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : { token: '', allowedUsers: [], allowAll: false, homeChannel: '' }
    const token = (resolved.token && resolved.token.trim()) || process.env.DISCORD_BOT_TOKEN || ''
    return { ...resolved, token }
  }

  let client = null

  const adapter = {
    id: 'discord',
    connected: false,
    capabilities: {
      streaming: true,
      typing: true,
      buttons: false,
      media: ['image'],
      markdown: 'plain',
      maxMessageLength: 1900,
    },
    resolveConfig,

    async connect() {
      if (client) return
      const cfg = resolveConfig()
      if (!cfg.token) {
        logger.warn('discord: token 未配置（settings messaging-discord.token 或 DISCORD_BOT_TOKEN）')
        return
      }
      const c = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
      })
      client = c
      try {
        c.on('messageCreate', (msg) => {
          handleMessage(msg).catch((error) => logger.error(`discord message failed: ${error.stack || error.message}`))
        })
        c.on('ready', () => {
          adapter.connected = true
          logger.info(`discord connected as ${c.user.tag} (${c.user.id})`)
        })
        await c.login(cfg.token)
      } catch (error) {
        // Failed login must not leave the client behind (reconnect on later
        // settings change would be blocked).
        client = null
        throw error
      }
    },

    async disconnect() {
      const c = client
      client = null
      adapter.connected = false
      if (c) {
        try {
          await c.destroy()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      const channel = await client.channels.fetch(target.chatId)
      const msg = await channel.send(text)
      return { messageId: String(msg.id) }
    },

    async editMessage(target, messageId, text) {
      const channel = await client.channels.fetch(target.chatId)
      const msg = await channel.messages.fetch(messageId)
      await msg.edit(text)
    },

    async sendTyping(target) {
      const channel = await client.channels.fetch(target.chatId)
      if (channel && typeof channel.sendTyping === 'function') await channel.sendTyping()
    },

    async sendMedia(target, media, caption) {
      const channel = await client.channels.fetch(target.chatId)
      const msg = await channel.send({ content: caption || undefined, files: [media.url] })
      return { messageId: String(msg.id) }
    },

    async getChatInfo(chatId) {
      const channel = await client.channels.fetch(chatId)
      return { name: channel && channel.name ? channel.name : String(chatId), type: channel ? channel.type : 'unknown', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.token) {
    adapter.connect().catch((error) => logger.error(`discord connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('discord: 未配置 token，等待配置（settings messaging-discord.token）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.token && !client) {
        adapter.connect().catch((error) => logger.error(`discord connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Normalize one Discord message into a messaging-core inbound event. */
  async function handleMessage(msg) {
    if (!client || !msg.author || msg.author.bot || msg.author.id === client.user.id) return
    if (!msg.content && msg.attachments.size === 0) return

    const isDM = msg.channel.type === ChannelType.DM
    let text = msg.content || ''

    if (!isDM) {
      const mentioned = msg.mentions.has(client.user.id)
      const repliedToBot = msg.type === MessageType.Reply && msg.referencedMessage && msg.referencedMessage.author && msg.referencedMessage.author.id === client.user.id
      if (!mentioned && !repliedToBot) return
      text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim()
    }

    if (msg.attachments.size > 0) {
      text = text ? `${text}\n[（附带 ${msg.attachments.size} 个附件，当前版本不解析媒体内容）]` : '[收到附件（当前版本不解析媒体内容）]'
    }
    if (!text) return

    await ctx.messaging.handleInbound('discord', {
      platform: 'discord',
      chatKey: `discord:${msg.channel.id}`,
      chatId: String(msg.channel.id),
      userId: String(msg.author.id),
      userName: msg.author.username,
      text,
      raw: msg,
    })
  }
}
