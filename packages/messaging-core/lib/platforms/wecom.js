/**
 * platform-wecom — WeCom (企业微信) AI Bot messaging adapter for DSH.
 *
 * Mirrors hermes-agent's WeCom AI Bot WebSocket gateway protocol:
 *   - authenticate with `aibot_subscribe` (bot_id + secret + device_id),
 *   - receive `aibot_msg_callback` events,
 *   - reply with `aibot_respond_msg` correlated to the inbound callback
 *     req_id (required for group chats — AI bots cannot initiate sends
 *     there), falling back to proactive `aibot_send_msg` for DMs,
 *   - application-level `ping` heartbeats every 30s.
 *
 * Configuration (settings namespace `messaging-wecom`):
 *   botId:        WeCom AI bot id (env: WECOM_BOT_ID)
 *   secret:       WeCom AI bot secret (env: WECOM_SECRET)
 *   websocketUrl: gateway URL (default wss://openws.work.weixin.qq.com)
 *   allowedUsers: userids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  reserved
 */
import z from 'schemastery'
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com'
const HEARTBEAT_INTERVAL = 30000
const CONNECT_TIMEOUT = 15000
const RECONNECT_BACKOFF = [2000, 5000, 10000, 30000, 60000]

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function register(ctx) {
  const logger = ctx.logger('wecom')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-wecom'), z.object({
      botId: z.string().default(''),
      secret: z.string().role('secret').default(''),
      websocketUrl: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-wecom' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      botId: (resolved.botId && resolved.botId.trim()) || process.env.WECOM_BOT_ID || '',
      secret: (resolved.secret && resolved.secret.trim()) || process.env.WECOM_SECRET || '',
      websocketUrl: (resolved.websocketUrl && resolved.websocketUrl.trim()) || process.env.WECOM_WEBSOCKET_URL || DEFAULT_WS_URL,
    }
  }

  function deviceId() {
    const file = join(dshHome(), 'messaging', 'wecom-device-id')
    try {
      if (existsSync(file)) return readFileSync(file, 'utf8').trim()
      mkdirSync(join(file, '..'), { recursive: true })
      const id = randomUUID()
      writeFileSync(file, id, 'utf8')
      return id
    } catch {
      return randomUUID()
    }
  }

  let ws = null
  let reqCounter = 0
  let heartbeatTimer = null
  let disposed = false
  let reconnectTimer = null
  let retries = 0
  /** req_id -> resolve(payload) for in-flight sends. */
  const pending = new Map()
  /** chatId -> latest inbound callback req_id (for respond correlation). */
  const lastReqIds = new Map()
  /** msgid dedup, bounded. */
  const seen = new Set()

  function newReqId(tag) {
    reqCounter += 1
    return `${tag}_${Date.now()}_${reqCounter}`
  }

  const adapter = {
    id: 'wecom',
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
      if (ws || disposed) return
      const cfg = resolveConfig()
      if (!cfg.botId || !cfg.secret) {
        logger.warn('wecom: 未配置（settings messaging-wecom.botId/secret 或环境变量）')
        return
      }
      const s = new WebSocket(cfg.websocketUrl)
      ws = s
      s.on('open', () => {
        sendFrame('aibot_subscribe', { bot_id: cfg.botId, secret: cfg.secret, device_id: deviceId() })
          .then((payload) => {
            const errcode = payload && payload.errcode
            if (errcode && errcode !== 0) {
              logger.error(`wecom subscribe failed: ${payload.errmsg || 'unknown'} (errcode=${errcode})`)
              s.close()
              return
            }
            retries = 0
            adapter.connected = true
            logger.info('wecom connected (AI Bot WS)')
            startHeartbeat()
          })
          .catch((error) => {
            logger.error(`wecom subscribe timeout/failed: ${error.message}`)
            s.close()
          })
      })
      s.on('message', (raw) => {
        handleFrame(raw).catch((error) => logger.error(`wecom frame failed: ${error.stack || error.message}`))
      })
      s.on('close', () => {
        stopHeartbeat()
        adapter.connected = false
        ws = null
        failPending(new Error('wecom connection closed'))
        if (!disposed) scheduleReconnect()
      })
      s.on('error', (error) => logger.warn(`wecom ws error: ${error.message}`))
    },

    async disconnect() {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      stopHeartbeat()
      const s = ws
      ws = null
      adapter.connected = false
      failPending(new Error('wecom disposed'))
      if (s) {
        try {
          s.close()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!ws) throw new Error('wecom: not connected')
      const body = { chatid: target.chatId, msgtype: 'markdown', markdown: { content: text.slice(0, 4000) } }
      const replyReqId = lastReqIds.get(target.chatId)
      const payload = await sendFrame(replyReqId ? 'aibot_respond_msg' : 'aibot_send_msg', body, replyReqId || undefined)
      const errcode = payload && payload.errcode
      if (errcode && errcode !== 0) {
        throw new Error(`wecom send failed: ${payload.errmsg || 'unknown'} (errcode=${errcode})`)
      }
      return {}
    },

    async sendTyping() { /* WeCom has no typing */ },

    async sendMedia() {
      throw new Error('wecom: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'wecom-chat', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  function scheduleReconnect() {
    const delay = RECONNECT_BACKOFF[Math.min(retries, RECONNECT_BACKOFF.length - 1)]
    retries += 1
    logger.warn(`wecom disconnected, reconnect in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      adapter.connect().catch((error) => logger.error(`wecom reconnect failed: ${error.message}`))
    }, delay)
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendFrame('ping', {}, undefined, true).catch(() => {})
      }
    }, HEARTBEAT_INTERVAL)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function failPending(error) {
    for (const resolve of pending.values()) resolve({ error })
    pending.clear()
  }

  /** Send one frame and resolve with its correlated ack (unless fireAndForget). */
  function sendFrame(cmd, body, reqIdOverride, fireAndForget = false) {
    const reqId = reqIdOverride || newReqId(cmd)
    return new Promise((resolve) => {
      if (!fireAndForget) {
        const timer = setTimeout(() => {
          pending.delete(reqId)
          resolve({ error: new Error('wecom ack timeout') })
        }, CONNECT_TIMEOUT)
        pending.set(reqId, (payload) => {
          clearTimeout(timer)
          pending.delete(reqId)
          resolve(payload)
        })
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ cmd, headers: { req_id: reqId }, body }))
      } else {
        if (!fireAndForget) {
          const resolvePending = pending.get(reqId)
          if (resolvePending) {
            pending.delete(reqId)
            resolvePending({ error: new Error('wecom socket not open') })
          }
        }
      }
      if (fireAndForget) resolve(null)
    })
  }

  /** Route inbound frames: acks to pending sends, callbacks to the agent. */
  async function handleFrame(raw) {
    let payload
    try {
      payload = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return
    const cmd = String(payload.cmd || '')
    const reqId = payload.headers && payload.headers.req_id ? String(payload.headers.req_id) : null
    if (cmd === 'aibot_msg_callback' || cmd === 'aibot_callback') {
      await handleCallback(payload)
      return
    }
    if (cmd === 'ping') return
    if (reqId && pending.has(reqId)) {
      const resolve = pending.get(reqId)
      pending.delete(reqId)
      resolve(payload)
    }
  }

  /** Normalize one aibot_msg_callback payload into a messaging-core inbound event. */
  async function handleCallback(payload) {
    const body = payload.body
    if (!body || typeof body !== 'object') return
    const msgId = String(body.msgid || '')
    if (msgId) {
      if (seen.has(msgId)) return
      seen.add(msgId)
      if (seen.size > 1000) seen.delete(seen.values().next().value)
    }
    const senderId = body.from && body.from.userid ? String(body.from.userid) : ''
    const chatId = String(body.chatid || senderId || '')
    if (!chatId) return
    const isGroup = String(body.chattype || '').toLowerCase() === 'group'
    const reqId = payload.headers && payload.headers.req_id ? String(payload.headers.req_id) : ''
    if (reqId) lastReqIds.set(chatId, reqId)

    let text = ''
    if (body.text && typeof body.text === 'object') text = String(body.text.content || '').trim()
    else if (typeof body.content === 'string') text = body.content.trim()
    if (isGroup) text = text.replace(/^@\S+\s*/, '').trim()
    if (!text) return

    await ctx.messaging.handleInbound('wecom', {
      platform: 'wecom',
      chatKey: `wecom:${chatId}`,
      chatId,
      userId: senderId,
      userName: senderId,
      text,
      raw: body,
    })
  }

  const initial = resolveConfig()
  if (initial.botId && initial.secret) {
    adapter.connect().catch((error) => logger.error(`wecom connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('wecom: 未配置，等待配置（settings messaging-wecom）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.botId && next.secret && !ws) {
        adapter.connect().catch((error) => logger.error(`wecom connect failed: ${error.stack || error.message}`))
      }
    })
  }
}
