/**
 * platform-api-server — OpenAI-compatible API server for DSH.
 *
 * Exposes the DSH agent over OpenAI Chat Completions wire format on the
 * messaging-core shared listener:
 *   - POST /v1/chat/completions — { model, messages, stream? }
 *   - GET  /v1/models — the configured model name
 *
 * Session continuity: each request maps to a messaging chat. The caller can
 * opt into per-caller sessions with the X-DSH-Session-Id header; without it
 * all API traffic shares one default session. The HTTP request stays open
 * until the agent's turn ends (mirrors the A2A adapter's sync pattern).
 * stream:true is answered with a single SSE chunk + [DONE] (no token-level
 * streaming in M0). Optional bearer token auth.
 *
 * Configuration (settings namespace `messaging-api-server`):
 *   apiToken:   optional bearer token for both endpoints (env: DSH_API_TOKEN)
 *   modelName:  model name reported by /v1/models (default "dsh-agent")
 *   homeChannel: reserved
 */
import z from 'schemastery'
import { randomUUID } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_SESSION = 'default'

export function register(ctx) {
  const logger = ctx.logger('api-server')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-api-server'), z.object({
      apiToken: z.string().role('secret').default(''),
      modelName: z.string().default('dsh-agent'),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-api-server' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      apiToken: (resolved.apiToken && resolved.apiToken.trim()) || process.env.DSH_API_TOKEN || '',
      modelName: (resolved.modelName && resolved.modelName.trim()) || 'dsh-agent',
      allowAll: true, // auth is the bearer token / loopback bind
    }
  }

  /** chatId -> { resolve } for in-flight chat/completions requests. */
  const pendingByChat = new Map()

  let unregisters = []

  const adapter = {
    id: 'api-server',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 32000,
    },
    resolveConfig,

    async connect() {
      if (unregisters.length > 0) return
      unregisters = [
        ctx.messaging.registerWebhook('/v1/chat/completions', (h) => handleChatCompletions(h)),
        ctx.messaging.registerWebhook('/v1/models', (h) => handleModels(h)),
      ]
      adapter.connected = true
      logger.info(`api-server ready at /v1/chat/completions${resolveConfig().apiToken ? ' (bearer auth)' : ' (loopback only)'}`)
    },

    async disconnect() {
      for (const unregister of unregisters) {
        try {
          unregister()
        } catch { /* ignore */ }
      }
      unregisters = []
      failAll(new Error('api-server disconnected'))
      adapter.connected = false
    },

    async send(target, text) {
      const pending = pendingByChat.get(target.chatId)
      if (pending) {
        pendingByChat.delete(target.chatId)
        clearTimeout(pending.timer)
        pending.resolve({ ok: true, text })
        return {}
      }
      logger.warn(`api-server: reply for ${target.chatId} without a pending request`)
      return {}
    },

    async sendTyping() { /* no typing */ },

    async sendMedia() {
      throw new Error('api-server: media unsupported')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'api-session', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  // Always register (loopback by default; harmless without a token).
  adapter.connect().catch((error) => logger.error(`api-server connect failed: ${error.stack || error.message}`))

  function failAll(error) {
    for (const pending of pendingByChat.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error })
    }
    pendingByChat.clear()
  }

  /** GET /v1/models */
  function handleModels({ headers, res }) {
    if (!authorized(headers)) {
      res.writeHead(401)
      res.end()
      return
    }
    const cfg = resolveConfig()
    const model = { id: cfg.modelName, object: 'model', created: 0, owned_by: 'dsh' }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [model] }))
  }

  /** POST /v1/chat/completions — dispatch and await the agent's reply. */
  async function handleChatCompletions({ headers, raw, res }) {
    if (!authorized(headers)) {
      res.writeHead(401)
      res.end()
      return
    }
    let request
    try {
      request = JSON.parse(raw.toString('utf8'))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
      return
    }
    const messages = Array.isArray(request.messages) ? request.messages : []
    const prompt = messages
      .map((m) => (m && typeof m.content === 'string' ? `${m.role || 'user'}: ${m.content}` : ''))
      .filter(Boolean)
      .join('\n')
    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'no text content in messages' } }))
      return
    }
    const stream = request.stream === true
    const sessionId = String(headers['x-dsh-session-id'] || DEFAULT_SESSION).slice(0, 128)
    const chatId = `api:${sessionId}`
    const requestId = `chatcmpl-${randomUUID().slice(0, 12)}`
    const modelName = resolveConfig().modelName

    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingByChat.delete(chatId)
        resolve({ ok: false, error: new Error('api request timeout') })
      }, REQUEST_TIMEOUT_MS)
      pendingByChat.set(chatId, { resolve, timer })
      ctx.messaging.handleInbound('api-server', {
        platform: 'api-server',
        chatKey: `api-server:${chatId}`,
        chatId,
        userId: 'api',
        userName: 'api',
        text: prompt,
        raw: request,
      }).catch((error) => {
        pendingByChat.delete(chatId)
        clearTimeout(timer)
        resolve({ ok: false, error })
      })
    })

    if (!reply.ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: reply.error ? reply.error.message || String(reply.error) : 'agent error' } }))
      return
    }
    const content = reply.text
    const finishReason = content.startsWith('⚠️ 本轮出错') ? 'error' : 'stop'
    const body = {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    }
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: body.created, model: modelName, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: body.created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
  }

  function authorized(headers) {
    const cfg = resolveConfig()
    if (!cfg.apiToken) return true
    const auth = headers.authorization
    return Boolean(auth && auth === `Bearer ${cfg.apiToken}`)
  }
}
