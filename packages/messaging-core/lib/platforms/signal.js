/**
 * platform-signal — Signal messaging adapter for DSH (signal-cli HTTP daemon).
 *
 * Requires a local signal-cli daemon running in HTTP mode:
 *   signal-cli -a <account> daemon --http 127.0.0.1:8080
 *
 * Inbound: SSE stream (GET /api/v1/events?account=...); outbound and typing
 * via JSON-RPC 2.0 over HTTP (POST /api/v1/rpc). Mirrors hermes-agent's
 * signal adapter protocol. Signal has no editable messages, so no streaming.
 *
 * Configuration (settings namespace `messaging-signal`):
 *   httpUrl:  signal-cli HTTP daemon URL (default http://127.0.0.1:8080)
 *   account:  the registered signal account number/uuid (env: SIGNAL_ACCOUNT)
 *   allowedUsers: source identifiers (number or uuid) allowed to talk
 *   allowAll: true to accept anyone (dev only)
 *   homeChannel: reserved
 */
import z from 'schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function register(ctx) {
  const logger = ctx.logger('signal')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-signal'), z.object({
      httpUrl: z.string().default('http://127.0.0.1:8080'),
      account: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-signal' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      httpUrl: ((resolved.httpUrl && resolved.httpUrl.trim()) || 'http://127.0.0.1:8080').replace(/\/+$/, ''),
      account: (resolved.account && resolved.account.trim()) || process.env.SIGNAL_ACCOUNT || '',
    }
  }

  let running = false
  let stop = false
  let retries = 0
  let rpcCounter = 0

  const adapter = {
    id: 'signal',
    connected: false,
    capabilities: {
      streaming: false,
      typing: true,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 2000,
    },
    resolveConfig,

    async connect() {
      if (running) return
      const cfg = resolveConfig()
      if (!cfg.account) {
        logger.warn('signal: 未配置 account（settings messaging-signal.account 或 SIGNAL_ACCOUNT）')
        return
      }
      // Health check (non-fatal).
      try {
        const check = await fetch(`${cfg.httpUrl}/api/v1/check`)
        if (!check.ok) logger.warn(`signal: signal-cli health check returned HTTP ${check.status}`)
      } catch (error) {
        logger.warn(`signal: signal-cli unreachable at ${cfg.httpUrl} (${error.message}) — 请确认已运行 signal-cli daemon --http`)
      }
      running = true
      stop = false
      adapter.connected = true
      logger.info(`signal SSE listening (account ${cfg.account})`)
      sseLoop().catch((error) => logger.error(`signal SSE loop failed: ${error.stack || error.message}`))
    },

    async disconnect() {
      stop = true
      running = false
      adapter.connected = false
    },

    async send(target, text) {
      const cfg = resolveConfig()
      const params = { account: cfg.account, message: text }
      if (target.chatId.startsWith('group:')) params.groupId = target.chatId.slice(6)
      else params.recipient = [target.chatId]
      const result = await rpc('send', params)
      if (result && result.error) throw new Error(`signal send failed: ${String(result.error.message || result.error)}`)
      return {}
    },

    async sendTyping(target) {
      const cfg = resolveConfig()
      const params = { account: cfg.account }
      if (target.chatId.startsWith('group:')) params.groupId = target.chatId.slice(6)
      else params.recipient = [target.chatId]
      try {
        await rpc('sendTyping', params)
      } catch { /* typing is best-effort */ }
    },

    async sendMedia() {
      throw new Error('signal: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: chatId.startsWith('group:') ? `Signal 群组 ${chatId.slice(6).slice(0, 8)}` : chatId, type: chatId.startsWith('group:') ? 'group' : 'dm', chatId }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.account) {
    adapter.connect().catch((error) => logger.error(`signal connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('signal: 未配置 account，等待配置（settings messaging-signal.account）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.account && !running) {
        adapter.connect().catch((error) => logger.error(`signal connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** JSON-RPC 2.0 call against signal-cli's HTTP daemon. */
  async function rpc(method, params, timeoutMs = 30000) {
    const cfg = resolveConfig()
    rpcCounter += 1
    const payload = { jsonrpc: '2.0', method, params, id: `${method}_${Date.now()}_${rpcCounter}` }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${cfg.httpUrl}/api/v1/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Stream /api/v1/events (SSE) with reconnect backoff. */
  async function sseLoop() {
    const cfg = resolveConfig()
    while (!stop) {
      try {
        const controller = new AbortController()
        const res = await fetch(`${cfg.httpUrl}/api/v1/events?account=${encodeURIComponent(cfg.account)}`, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        retries = 0
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 1)
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim()
              if (data) {
                try {
                  await handleEnvelope(JSON.parse(data))
                } catch (error) {
                  logger.warn(`signal envelope failed: ${error.message}`)
                }
              }
            }
          }
        }
        throw new Error('SSE stream ended')
      } catch (error) {
        if (stop) break
        retries += 1
        const delay = Math.min(60000, 2000 * 2 ** retries)
        logger.warn(`signal SSE disconnected (${error.message}), reconnect in ${delay}ms`)
        await sleep(delay)
      }
    }
    adapter.connected = false
  }

  /** Normalize one signal-cli envelope into a messaging-core inbound event. */
  async function handleEnvelope(data) {
    const cfg = resolveConfig()
    const envelope = data && data.envelope ? data.envelope : data
    if (!envelope) return
    let dm = envelope.dataMessage
    // Note to Self arrives wrapped in syncMessage.sentMessage.
    if (!dm && envelope.syncMessage && envelope.syncMessage.sentMessage && envelope.syncMessage.sentMessage.dataMessage) {
      dm = envelope.syncMessage.sentMessage.dataMessage
    }
    if (!dm || !dm.body) return

    const source = dm.sourceNumber || dm.sourceUuid || ''
    if (!source || source === cfg.account) return // echo/self

    const isGroup = Boolean(dm.groupId)
    const chatKey = isGroup ? `signal:group:${dm.groupId}` : `signal:${source}`
    const chatId = isGroup ? `group:${dm.groupId}` : source

    await ctx.messaging.handleInbound('signal', {
      platform: 'signal',
      chatKey,
      chatId,
      userId: source,
      userName: source,
      text: String(dm.body).trim(),
      raw: envelope,
    })
  }
}
