/**
 * platform-webhook — generic webhook messaging adapter for DSH.
 *
 * Registers configurable HTTP routes on the messaging-core shared listener.
 * Each route: HMAC-SHA256 signature verification (header X-Webhook-Signature,
 * hex of the raw body with the route secret), a prompt template rendered with
 * the JSON payload, and a deliverUrl that receives the agent's reply as
 * JSON { text } via POST.
 *
 * Configuration (settings namespace `messaging-webhook`):
 *   routes:
 *     - path:        "/github"          # route on the shared listener
 *       secret:      "..."              # HMAC secret (required)
 *       prompt:      "处理 GitHub 事件：{{payload}}"
 *       deliverUrl:  "https://..."      # reply target (optional; log-only when empty)
 */
import z from 'schemastery'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const MAX_PAYLOAD_CHARS = 4000

export function register(ctx) {
  const logger = ctx.logger('webhook')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-webhook'), z.object({
      routes: z.array(z.object({
        path: z.string(),
        secret: z.string(),
        prompt: z.string().default('处理 webhook 事件：{{payload}}'),
        deliverUrl: z.string().default(''),
      })).default([]),
      // Each route carries its own secret auth; core allowlist must not block
      // webhook events by default.
      allowAll: z.boolean().default(true),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-webhook' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    return cfgScope ? cfgScope.get() : { routes: [], homeChannel: '' }
  }

  let unregisters = []

  const adapter = {
    id: 'webhook',
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
      if (unregisters.length > 0) return
      const cfg = resolveConfig()
      const routes = Array.isArray(cfg.routes) ? cfg.routes : []
      if (routes.length === 0) {
        logger.warn('webhook: 未配置 routes（settings messaging-webhook.routes）')
        return
      }
      for (const route of routes) {
        if (!route || !route.path || !route.secret) {
          logger.warn(`webhook: 跳过无效路由 ${route && route.path}`)
          continue
        }
        if (!route.path.startsWith('/')) route.path = `/${route.path}`
        const unregister = ctx.messaging.registerWebhook(route.path, (h) => handleWebhook(route, h))
        unregisters.push(unregister)
        logger.info(`webhook route ready at ${route.path}${route.deliverUrl ? ' (deliver: ' + route.deliverUrl + ')' : ' (log-only)'}`)
      }
      adapter.connected = true
    },

    async disconnect() {
      for (const unregister of unregisters) {
        try {
          unregister()
        } catch { /* ignore */ }
      }
      unregisters = []
      adapter.connected = false
    },

    async send(target, text) {
      const cfg = resolveConfig()
      const routes = Array.isArray(cfg.routes) ? cfg.routes : []
      const route = routes.find((r) => r && r.path && target.chatId === r.path)
      if (route && route.deliverUrl) {
        const res = await fetch(route.deliverUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!res.ok) throw new Error(`webhook deliver failed: HTTP ${res.status}`)
      } else {
        logger.info(`webhook reply (log-only) for ${target.chatId}: ${text.slice(0, 200)}`)
      }
      return {}
    },

    async sendTyping() { /* webhook has no typing */ },

    async sendMedia() {
      throw new Error('webhook: media unsupported')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'webhook', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (Array.isArray(initial.routes) && initial.routes.length > 0) {
    adapter.connect().catch((error) => logger.error(`webhook connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('webhook: 未配置 routes，等待配置（settings messaging-webhook.routes）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (Array.isArray(next.routes) && next.routes.length > 0 && unregisters.length === 0) {
        adapter.connect().catch((error) => logger.error(`webhook connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Verify HMAC, render the prompt, and dispatch to the agent. */
  async function handleWebhook(route, { raw, headers, res }) {
    const signature = headers['x-webhook-signature']
    const expected = createHmac('sha256', route.secret).update(raw).digest('hex')
    if (!signature || !safeEqual(String(signature), expected)) {
      res.writeHead(401)
      res.end()
      return
    }
    let payloadText
    try {
      const parsed = JSON.parse(raw.toString('utf8'))
      payloadText = JSON.stringify(parsed, null, 2).slice(0, MAX_PAYLOAD_CHARS)
    } catch {
      payloadText = raw.toString('utf8').slice(0, MAX_PAYLOAD_CHARS)
    }
    const prompt = String(route.prompt || '处理 webhook 事件：{{payload}}').replace(/\{\{payload\}\}/g, payloadText)
    res.writeHead(200)
    res.end('ok')
    await ctx.messaging.handleInbound('webhook', {
      platform: 'webhook',
      chatKey: `webhook:${route.path}`,
      chatId: String(route.path),
      userId: 'webhook',
      text: prompt,
      raw: { path: route.path, payloadText },
    })
  }
}

function safeEqual(a, b) {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}
