/**
 * platform-a2a — A2A (Agent2Agent) v1.0 protocol server for DSH.
 *
 * Exposes the DSH agent as an A2A-discoverable agent on the messaging-core
 * shared listener:
 *   - GET  /.well-known/agent-card.json  (and legacy /agent.json)
 *   - POST /a2a — JSON-RPC 2.0: message/send (synchronous request/response),
 *     tasks/get
 *
 * Each inbound task routes into the normal messaging chat path; the HTTP
 * request stays open until the agent's turn ends, then the reply is returned
 * as a completed Task. Auth: optional bearer token (Authorization header);
 * with no token the listener stays loopback-bound (default 127.0.0.1).
 *
 * Configuration (settings namespace `messaging-a2a`):
 *   agentName:   agent name shown in the card (default "DSH Agent")
 *   bearerToken: optional token for POST /a2a (env: A2A_BEARER_TOKEN)
 *   publicUrl:   informational public base URL (card url field)
 *   homeChannel: reserved
 */
import z from 'schemastery'
import { randomUUID } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const MESSAGE_TIMEOUT_MS = 5 * 60 * 1000

export function register(ctx) {
  const logger = ctx.logger('a2a')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-a2a'), z.object({
      agentName: z.string().default('DSH Agent'),
      bearerToken: z.string().role('secret').default(''),
      publicUrl: z.string().default(''),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-a2a' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      agentName: (resolved.agentName && resolved.agentName.trim()) || 'DSH Agent',
      bearerToken: (resolved.bearerToken && resolved.bearerToken.trim()) || process.env.A2A_BEARER_TOKEN || '',
      allowAll: true, // auth is the bearer token / loopback bind
    }
  }

  /** chatId (session key) -> { resolve } for in-flight message/send requests. */
  const pendingByChat = new Map()
  /** taskId -> { state, reply? } for tasks/get (bounded). */
  const taskStore = new Map()

  let unregisters = []

  const adapter = {
    id: 'a2a',
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
      unregisters = [
        ctx.messaging.registerWebhook('/.well-known/agent-card.json', (h) => handleCard(h)),
        ctx.messaging.registerWebhook('/agent.json', (h) => handleCard(h)),
        ctx.messaging.registerWebhook('/a2a', (h) => handleRpc(h)),
      ]
      adapter.connected = true
      logger.info(`a2a ready at /a2a${resolveConfig().bearerToken ? ' (bearer auth)' : ' (loopback only)'}`)
    },

    async disconnect() {
      for (const unregister of unregisters) {
        try {
          unregister()
        } catch { /* ignore */ }
      }
      unregisters = []
      failAll(new Error('a2a disconnected'))
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
      logger.warn(`a2a: reply for ${target.chatId} without a pending request (send_message tool?)`)
      return {}
    },

    async sendTyping() { /* A2A has no typing */ },

    async sendMedia() {
      throw new Error('a2a: media unsupported')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'a2a-session', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (true) {
    // Always register (the card + loopback endpoint are harmless without auth).
    adapter.connect().catch((error) => logger.error(`a2a connect failed: ${error.stack || error.message}`))
  }

  function failAll(error) {
    for (const pending of pendingByChat.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error })
    }
    pendingByChat.clear()
  }

  /** GET agent card. */
  function handleCard({ res }) {
    const cfg = resolveConfig()
    const card = {
      protocolVersion: '1.0',
      name: cfg.agentName,
      description: 'DSH agent exposed over A2A v1.0 (text chat)',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      skills: [{ id: 'chat', name: 'Chat', description: '与 DSH agent 对话', tags: [] }],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      url: cfg.publicUrl ? `${cfg.publicUrl}/a2a` : '/a2a',
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(card))
  }

  /** POST /a2a — JSON-RPC 2.0 dispatch. */
  async function handleRpc({ headers, raw, res }) {
    const cfg = resolveConfig()
    if (cfg.bearerToken) {
      const auth = headers.authorization
      if (!auth || auth !== `Bearer ${cfg.bearerToken}`) {
        res.writeHead(401)
        res.end()
        return
      }
    }
    let request
    try {
      request = JSON.parse(raw.toString('utf8'))
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const respond = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result }))
    }
    const respondError = (code, message) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, error: { code, message } }))
    }
    try {
      if (request.method === 'message/send') {
        await handleMessageSend(request, respond, respondError)
      } else if (request.method === 'tasks/get') {
        const task = request.params && request.params.id ? taskStore.get(String(request.params.id)) : undefined
        if (!task) respondError(-32002, 'task not found')
        else respond({ id: task.taskId, status: { state: task.state } })
      } else {
        respondError(-32601, `method not found: ${request.method}`)
      }
    } catch (error) {
      logger.error(`a2a rpc failed: ${error.stack || error.message}`)
      respondError(-32000, error.message || 'internal error')
    }
  }

  /** message/send: extract text, dispatch to the agent, await the reply. */
  async function handleMessageSend(request, respond, respondError) {
    const params = request.params || {}
    const message = params.message || {}
    const text = extractText(message)
    if (!text) {
      respondError(-32002, 'empty message')
      return
    }
    const peer = String(request.originator || 'a2a-peer')
    const sessionKey = String(params.sessionId || `peer:${peer}`)
    const taskId = randomUUID()
    const chatId = sessionKey

    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingByChat.delete(chatId)
        resolve({ ok: false, error: new Error('a2a message timeout') })
      }, MESSAGE_TIMEOUT_MS)
      pendingByChat.set(chatId, { resolve, timer })
      ctx.messaging.handleInbound('a2a', {
        platform: 'a2a',
        chatKey: `a2a:${sessionKey}`,
        chatId: sessionKey,
        userId: peer,
        userName: peer,
        text,
        raw: params,
      }).catch((error) => {
        pendingByChat.delete(chatId)
        clearTimeout(timer)
        resolve({ ok: false, error })
      })
    })

    taskStore.set(taskId, { taskId, state: reply.ok ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED' })
    if (taskStore.size > 200) taskStore.delete(taskStore.keys().next().value)

    if (!reply.ok) {
      respondError(-32000, reply.error ? reply.error.message || String(reply.error) : 'agent error')
      return
    }
    respond({
      id: taskId,
      sessionId: sessionKey,
      status: { state: 'TASK_STATE_COMPLETED' },
      artifacts: [{ name: 'response', parts: [{ text: reply.text }] }],
    })
  }
}

/** Extract the first text part from an A2A message (tolerant of shapes). */
function extractText(message) {
  if (!message || typeof message !== 'object') return ''
  const parts = Array.isArray(message.parts) ? message.parts : []
  for (const part of parts) {
    if (part && typeof part.text === 'string' && part.text.trim()) return part.text.trim()
    if (part && typeof part === 'string' && part.trim()) return part.trim()
  }
  if (typeof message.text === 'string') return message.text.trim()
  return ''
}
