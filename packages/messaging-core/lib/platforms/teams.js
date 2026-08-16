/**
 * platform-teams — Microsoft Teams messaging adapter for DSH (Bot Framework).
 *
 * Webhook route /teams on the messaging-core shared listener; the
 * BotFrameworkAdapter validates the Entra JWT and drives the activity
 * protocol. Conversation references are retained per chat so asynchronous
 * agent replies use continueConversation. Group chats / channels require a
 * bot @mention (mention entities are stripped from the text).
 *
 * Configuration (settings namespace `messaging-teams`):
 *   clientId:    Entra app (bot) client id (env: TEAMS_CLIENT_ID)
 *   clientSecret: Entra app client secret (env: TEAMS_CLIENT_SECRET)
 *   tenantId:    optional channel auth tenant
 *   allowedUsers: AAD object ids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   publicUrl:    informational public base URL (route is /teams)
 *   homeChannel:  reserved
 *
 * Prerequisite: an Azure Bot resource registered with the messaging
 * endpoint <publicUrl>/teams (production requires HTTPS).
 */
import z from 'schemastery'
import { BotFrameworkAdapter, TurnContext } from 'botbuilder'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('teams')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-teams'), z.object({
      clientId: z.string().default(''),
      clientSecret: z.string().role('secret').default(''),
      tenantId: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      publicUrl: z.string().default(''),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-teams' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      clientId: (resolved.clientId && resolved.clientId.trim()) || process.env.TEAMS_CLIENT_ID || '',
      clientSecret: (resolved.clientSecret && resolved.clientSecret.trim()) || process.env.TEAMS_CLIENT_SECRET || '',
    }
  }

  let adapter = null
  let unregisterWebhook = null
  /** chatId (conversation id) -> ConversationReference for async replies. */
  const refs = new Map()

  const adapterObj = {
    id: 'teams',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 28000,
    },
    resolveConfig,

    async connect() {
      if (adapter) return
      const cfg = resolveConfig()
      if (!cfg.clientId || !cfg.clientSecret) {
        logger.warn('teams: 未配置（settings messaging-teams.clientId/clientSecret 或环境变量）')
        return
      }
      const a = new BotFrameworkAdapter({
        appId: cfg.clientId,
        appPassword: cfg.clientSecret,
        ...(cfg.tenantId ? { channelAuthTenant: cfg.tenantId } : {}),
      })
      adapter = a
      a.onTurnError = (turnContext, error) => {
        logger.error(`teams turn error: ${error.stack || error.message}`)
      }
      unregisterWebhook = ctx.messaging.registerWebhook('/teams', (h) => a.processActivity(h.req, h.res, (turnContext) => handleActivity(turnContext)))
      adapterObj.connected = true
      logger.info(`teams webhook ready at /teams${cfg.publicUrl ? ` (public: ${cfg.publicUrl}/teams)` : ''}`)
    },

    async disconnect() {
      if (unregisterWebhook) {
        try {
          unregisterWebhook()
        } catch { /* ignore */ }
        unregisterWebhook = null
      }
      adapter = null
      adapterObj.connected = false
    },

    async send(target, text) {
      if (!adapter) throw new Error('teams: not connected')
      const ref = refs.get(target.chatId)
      if (!ref) throw new Error(`teams: no conversation reference for ${target.chatId} (wait for an inbound message first)`)
      // Documented 2-arg form: continueConversation(reference, logic). The
      // 3-arg overload takes an oAuthScope, not a bot app id.
      await adapter.continueConversation(ref, async (turnContext) => {
        await turnContext.sendActivity(text)
      })
      return {}
    },

    async sendTyping() { /* Teams typing via activity unsupported in M0 */ },

    async sendMedia() {
      throw new Error('teams: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'conversation', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapterObj)
  ctx.on('dispose', () => {
    unregister()
    adapterObj.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.clientId && initial.clientSecret) {
    adapterObj.connect().catch((error) => logger.error(`teams connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('teams: 未配置，等待配置（settings messaging-teams）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.clientId && next.clientSecret && !adapter) {
        adapterObj.connect().catch((error) => logger.error(`teams connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Normalize one Teams activity into a messaging-core inbound event. */
  async function handleActivity(turnContext) {
    const activity = turnContext.activity
    if (!activity || activity.type !== 'message' || !activity.text) return
    const conversation = activity.conversation
    const from = activity.from
    if (!conversation || !conversation.id || !from || !from.id) return
    const chatId = String(conversation.id)
    const convType = String(conversation.conversationType || '')
    const botId = activity.recipient && activity.recipient.id ? String(activity.recipient.id) : null

    refs.set(chatId, TurnContext.getConversationReference(activity))
    if (refs.size > 200) refs.delete(refs.keys().next().value)

    let text = String(activity.text).trim()
    const isShared = convType === 'channel' || convType === 'groupChat'
    if (isShared) {
      const mentioned = Array.isArray(activity.entities) && activity.entities.some((e) => e && e.type === 'mention' && e.mentioned && botId && e.mentioned.id === botId)
      if (!mentioned) return
      text = text.replace(/<at>[\s\S]*?<\/at>/g, '').trim()
    }
    if (!text) return

    await ctx.messaging.handleInbound('teams', {
      platform: 'teams',
      chatKey: `teams:${chatId}`,
      chatId,
      userId: String(from.id),
      userName: from.name || String(from.id),
      text,
      raw: activity,
    })
  }
}
