/**
 * platform-ntfy — ntfy push messaging adapter for DSH.
 *
 * Pure HTTP (no runtime deps): subscribes to a topic via JSON long polling
 * (with reconnect backoff) and publishes replies back. No streaming or
 * typing. Authorization is the topic itself (subscribe/publish tokens), so
 * this adapter always authorizes inbound messages — the shared core
 * allowlist is bypassed for ntfy by design.
 *
 * Configuration (settings namespace `messaging-ntfy`):
 *   serverUrl:    ntfy server, default https://ntfy.sh
 *   topic:        subscribe topic (required)
 *   token:        access token for subscribe/publish (optional)
 *   publishTopic: topic replies are published to (default: subscribe topic)
 *   homeChannel:  default topic for cron/notification delivery (reserved)
 */
import z from 'schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function register(ctx) {
  const logger = ctx.logger('ntfy')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-ntfy'), z.object({
      serverUrl: z.string().default('https://ntfy.sh'),
      topic: z.string().default(''),
      token: z.string().role('secret').default(''),
      publishTopic: z.string().default(''),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-ntfy' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : { serverUrl: 'https://ntfy.sh', topic: '', token: '', publishTopic: '', homeChannel: '' }
    return {
      ...resolved,
      serverUrl: (resolved.serverUrl && resolved.serverUrl.trim()) || 'https://ntfy.sh',
      topic: (resolved.topic && resolved.topic.trim()) || process.env.NTFY_TOPIC || '',
      // The topic + token IS the auth gate for ntfy.
      allowAll: true,
    }
  }

  let polling = false
  let stopPolling = false
  let lastId = null
  let retries = 0

  const adapter = {
    id: 'ntfy',
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
      if (polling) return
      const cfg = resolveConfig()
      if (!cfg.topic) {
        logger.warn('ntfy: 未配置 topic（settings messaging-ntfy.topic 或 NTFY_TOPIC）')
        return
      }
      polling = true
      adapter.connected = true
      logger.info(`ntfy subscribed to ${cfg.serverUrl}/${cfg.topic}`)
      pollLoop().catch((error) => logger.error(`ntfy poll loop failed: ${error.stack || error.message}`))
    },

    async disconnect() {
      stopPolling = true
      polling = false
      adapter.connected = false
    },

    async send(target, text) {
      const cfg = resolveConfig()
      const publishTopic = cfg.publishTopic || target.chatId || cfg.topic
      const headers = { 'Content-Type': 'text/plain' }
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
      const res = await fetch(`${cfg.serverUrl}/${publishTopic}`, { method: 'POST', headers, body: text })
      if (!res.ok) throw new Error(`ntfy publish failed: HTTP ${res.status}`)
      return {}
    },

    async sendTyping() { /* ntfy has no typing */ },

    async sendMedia() {
      throw new Error('ntfy: media unsupported')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'topic', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.topic) {
    adapter.connect().catch((error) => logger.error(`ntfy connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('ntfy: 未配置 topic，等待配置（settings messaging-ntfy.topic）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.topic && !polling) {
        adapter.connect().catch((error) => logger.error(`ntfy connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Long-poll the topic's JSON feed and dispatch message events. */
  async function pollLoop() {
    const cfg = resolveConfig()
    while (!stopPolling) {
      try {
        const since = lastId ? `&since=${encodeURIComponent(lastId)}` : ''
        const url = `${cfg.serverUrl}/${encodeURIComponent(cfg.topic)}/json?poll=1&timeout=25${since}`
        const headers = {}
        if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
        const res = await fetch(url, { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const messages = await res.json()
        const list = Array.isArray(messages) ? messages : [messages]
        for (const m of list) {
          if (!m || m.event !== 'message' || !m.message) continue
          lastId = m.id
          retries = 0
          await handleMessage(m)
        }
      } catch (error) {
        retries += 1
        const delay = Math.min(60000, 5000 * 2 ** retries)
        logger.warn(`ntfy poll failed (${error.message}), retry in ${delay}ms`)
        await sleep(delay)
      }
    }
  }

  /** Normalize one ntfy message into a messaging-core inbound event. */
  async function handleMessage(m) {
    const text = m.title ? `${m.title}\n${m.message}` : m.message
    await ctx.messaging.handleInbound('ntfy', {
      platform: 'ntfy',
      chatKey: `ntfy:${m.topic}`,
      chatId: String(m.topic),
      userId: 'ntfy',
      text,
      raw: m,
    })
  }
}
