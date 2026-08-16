/**
 * platform-telegram — Telegram messaging adapter for DSH.
 *
 * grammY long polling; supports streaming edits (HTML), typing indicators,
 * text/photo/document sends, DM + group mention gating, and the shared
 * allowlist authorization provided by messaging-core.
 *
 * Configuration (settings namespace `messaging-telegram`, or env fallback):
 *   token:        Telegram bot token from @BotFather (env: TELEGRAM_BOT_TOKEN)
 *   allowedUsers: array of numeric user ids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  default chat id for cron/notification delivery (reserved)
 */
import z from 'schemastery'
import { Bot } from 'grammy'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function register(ctx) {
  const logger = ctx.logger('telegram')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-telegram'), z.object({
      token: z.string().role('secret').default(''),
      allowedUsers: z.array(z.union([z.number(), z.string()])).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-telegram' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : { token: '', allowedUsers: [], allowAll: false, homeChannel: '' }
    const token = (resolved.token && resolved.token.trim()) || process.env.TELEGRAM_BOT_TOKEN || ''
    return { ...resolved, token }
  }

  let bot = null
  let me = null
  let running = null // bot.start() promise

  const adapter = {
    id: 'telegram',
    connected: false,
    capabilities: {
      streaming: true,
      typing: true,
      buttons: false,
      media: ['photo', 'audio', 'document', 'video'],
      markdown: 'html',
      maxMessageLength: 4000,
    },
    resolveConfig,

    async connect() {
      if (bot) return
      const cfg = resolveConfig()
      if (!cfg.token) {
        logger.warn('telegram: token 未配置（settings messaging-telegram.token 或 TELEGRAM_BOT_TOKEN）')
        return
      }
      const b = new Bot(cfg.token)
      bot = b
      try {
        b.on('message', (msgCtx) => {
          handleUpdate(msgCtx).catch((error) => logger.error(`telegram update failed: ${error.stack || error.message}`))
        })
        await b.init()
        me = b.botInfo
        await b.api.deleteWebhook().catch(() => { /* not configured as webhook */ })
        running = b.start({
          onStart: () => {
            adapter.connected = true
            logger.info(`telegram connected as @${me.username} (${me.id})`)
          },
        }).catch((error) => {
          logger.error(`telegram polling stopped: ${error.message}`)
        })
      } catch (error) {
        // A failed connect must not leave the instance behind, or a later
        // settings change can never trigger a reconnect.
        bot = null
        me = null
        throw error
      }
    },

    async disconnect() {
      const b = bot
      bot = null
      me = null
      adapter.connected = false
      if (b) {
        try {
          await b.stop()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      const chatId = Number(target.chatId)
      const extra = target.threadId ? { message_thread_id: Number(target.threadId) } : {}
      try {
        const result = await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra })
        return { messageId: String(result.message_id) }
      } catch (error) {
        if (isParseError(error)) {
          const result = await bot.api.sendMessage(chatId, text, { ...extra })
          return { messageId: String(result.message_id) }
        }
        throw error
      }
    },

    async editMessage(target, messageId, text) {
      const chatId = Number(target.chatId)
      const extra = target.threadId ? { message_thread_id: Number(target.threadId) } : {}
      try {
        await bot.api.editMessageText(chatId, Number(messageId), text, { parse_mode: 'HTML', ...extra })
      } catch (error) {
        if (isNotModified(error)) return
        if (isParseError(error)) {
          await bot.api.editMessageText(chatId, Number(messageId), text, { ...extra })
          return
        }
        throw error
      }
    },

    async sendTyping(target) {
      await bot.api.sendChatAction(Number(target.chatId), 'typing')
    },

    async sendMedia(target, media, caption) {
      const chatId = Number(target.chatId)
      const extra = target.threadId ? { message_thread_id: Number(target.threadId) } : {}
      const cap = caption ? { caption, parse_mode: 'HTML', ...extra } : extra
      let result
      if (media.type === 'photo') result = await bot.api.sendPhoto(chatId, media.url, cap)
      else if (media.type === 'document') result = await bot.api.sendDocument(chatId, media.url, cap)
      else if (media.type === 'video') result = await bot.api.sendVideo(chatId, media.url, cap)
      else if (media.type === 'audio') result = await bot.api.sendAudio(chatId, media.url, cap)
      else {
        await bot.api.sendMessage(chatId, `[媒体] ${media.url || ''}`, { ...extra })
        return {}
      }
      return { messageId: String(result.message_id) }
    },

    async getChatInfo(chatId) {
      const chat = await bot.api.getChat(Number(chatId))
      return { name: chat.title || chat.first_name || String(chatId), type: chat.type, chatId: String(chat.id) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  // Connect now if configured; also react to later configuration changes.
  const initial = resolveConfig()
  if (initial.token) {
    adapter.connect().catch((error) => logger.error(`telegram connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('telegram: 未配置 token，等待配置（settings messaging-telegram.token）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.token && !bot) {
        adapter.connect().catch((error) => logger.error(`telegram connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Normalize one Telegram message update into a messaging-core inbound event. */
  async function handleUpdate(msgCtx) {
    if (!me) return
    const m = msgCtx.message
    if (!m || !m.from || m.from.is_bot || m.from.id === me.id) return

    const chat = m.chat
    const isGroup = chat.type === 'group' || chat.type === 'supergroup'
    let text = m.text || m.caption || ''
    const hasMedia = Boolean(m.photo || m.voice || m.document || m.video || m.audio || m.sticker)

    if (isGroup) {
      const mention = `@${me.username}`
      const entities = m.entities || m.caption_entities || []
      const mentioned = entities.some((e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length) === mention)
      const repliedToBot = m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.id === me.id
      if (!mentioned && !repliedToBot) return
      text = text.replace(new RegExp(escapeRegExp(mention), 'g'), '').trim()
    }

    if (hasMedia) {
      text = text ? `${text}\n[（附带一个附件，当前版本不解析媒体内容）]` : '[收到一个附件（图片/语音/文件），当前版本不解析媒体内容]'
    }
    if (!text) return

    await ctx.messaging.handleInbound('telegram', {
      platform: 'telegram',
      chatKey: `telegram:${chat.id}`,
      chatId: String(chat.id),
      threadId: m.message_thread_id ? String(m.message_thread_id) : undefined,
      userId: String(m.from.id),
      userName: m.from.username || m.from.first_name || String(m.from.id),
      text,
      raw: m,
    })
  }
}

function isNotModified(error) {
  return /not modified/i.test(String(error && error.message ? error.message : error))
}

function isParseError(error) {
  return /can't parse entities|parse entities/i.test(String(error && error.message ? error.message : error))
}
