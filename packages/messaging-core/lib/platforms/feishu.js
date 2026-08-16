/**
 * platform-feishu — Feishu/Lark messaging adapter for DSH.
 *
 * Official @larksuiteoapi/node-sdk with WebSocket long-connection event
 * subscription (no public URL needed). Bot receives messages via
 * im.message.receive_v1; replies are sent through the im.message.create API.
 * Group messages require the bot to be @mentioned (mention placeholders are
 * stripped from the text).
 *
 * Configuration (settings namespace `messaging-feishu`):
 *   appId:        Feishu app id (env: FEISHU_APP_ID)
 *   appSecret:    Feishu app secret (env: FEISHU_APP_SECRET)
 *   allowedUsers: open_id / union_id values allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  default chat id for cron/notification delivery (reserved)
 *
 * Feishu app needs the im:message bot permission and the "receive message"
 * event subscription (long-connection mode).
 */
import z from 'schemastery'
import lark from '@larksuiteoapi/node-sdk'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('feishu')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-feishu'), z.object({
      appId: z.string().default(''),
      appSecret: z.string().role('secret').default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-feishu' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      appId: (resolved.appId && resolved.appId.trim()) || process.env.FEISHU_APP_ID || '',
      appSecret: (resolved.appSecret && resolved.appSecret.trim()) || process.env.FEISHU_APP_SECRET || '',
    }
  }

  let client = null
  let wsClient = null
  let botOpenId = null

  const adapter = {
    id: 'feishu',
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
      if (wsClient) return
      const cfg = resolveConfig()
      if (!cfg.appId || !cfg.appSecret) {
        logger.warn('feishu: 未配置（settings messaging-feishu.appId/appSecret 或环境变量）')
        return
      }
      const c = new lark.Client({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        appType: lark.AppType.SelfBuild,
        domain: lark.Domain.Feishu,
      })
      client = c
      try {
        const botInfo = await c.bot.info({})
        botOpenId = botInfo && botInfo.data && botInfo.data.bot ? botInfo.data.bot.open_id : null
      } catch (error) {
        logger.warn(`feishu bot info failed: ${error.message}`)
      }
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data) => {
          handleEvent(data).catch((error) => logger.error(`feishu event failed: ${error.stack || error.message}`))
        },
      })
      const w = new lark.WSClient({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        domain: lark.Domain.Feishu,
        eventDispatcher: dispatcher,
        loggerLevel: lark.LoggerLevel.ERROR,
      })
      wsClient = w
      try {
        await w.start()
        adapter.connected = true
        logger.info(`feishu connected (app ${cfg.appId}${botOpenId ? `, bot ${botOpenId}` : ''})`)
      } catch (error) {
        // Failed connect must not leave the client behind (reconnect on
        // later settings change would be blocked).
        wsClient = null
        client = null
        botOpenId = null
        throw error
      }
    },

    async disconnect() {
      const w = wsClient
      wsClient = null
      client = null
      botOpenId = null
      adapter.connected = false
      if (w) {
        try {
          if (typeof w.close === 'function') await w.close()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!client) throw new Error('feishu: not connected')
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: target.chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      })
      return {}
    },

    async sendTyping() { /* Feishu has no typing API */ },

    async sendMedia() {
      throw new Error('feishu: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      try {
        const res = await client.im.chat.get({ path: { chat_id: chatId } })
        return { name: res.data && res.data.name ? res.data.name : String(chatId), type: 'chat', chatId: String(chatId) }
      } catch {
        return { name: String(chatId), type: 'chat', chatId: String(chatId) }
      }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.appId && initial.appSecret) {
    adapter.connect().catch((error) => logger.error(`feishu connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('feishu: 未配置，等待配置（settings messaging-feishu）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.appId && next.appSecret && !wsClient) {
        adapter.connect().catch((error) => logger.error(`feishu connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Normalize one im.message.receive_v1 event into a messaging-core inbound event. */
  async function handleEvent(data) {
    const message = data && data.event && data.event.message
    if (!message || !message.message_id || !message.chat_id) return
    const sender = data.event.sender
    if (!sender || !sender.sender_id) return
    const userId = sender.sender_id.open_id || sender.sender_id.union_id || ''
    if (!userId) return

    const isGroup = message.chat_type === 'group'
    let text = ''
    if (message.message_type === 'text') {
      try {
        text = String(JSON.parse(message.content).text || '').trim()
      } catch { /* non-text content */ }
    } else {
      text = '[收到非文本消息（富文本/图片/文件），当前版本不解析]'
    }

    if (isGroup) {
      const mentions = Array.isArray(message.mentions) ? message.mentions : []
      const mentionedBot = botOpenId ? mentions.some((m) => m && m.id && m.id.open_id === botOpenId) : false
      const hasPlaceholder = /@_user_\d+/.test(text)
      if (!mentionedBot && !hasPlaceholder) return
      text = text.replace(/@_user_\d+/g, '').trim()
    }
    if (!text) return

    await ctx.messaging.handleInbound('feishu', {
      platform: 'feishu',
      chatKey: `feishu:${message.chat_id}`,
      chatId: String(message.chat_id),
      userId,
      userName: userId,
      text,
      raw: data.event,
    })
  }
}
