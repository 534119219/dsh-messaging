/**
 * platform-yuanbao — Tencent Yuanbao bot adapter for DSH.
 *
 * Faithful port of hermes-agent's yuanbao adapter protocol:
 *   1. sign-token: POST {apiDomain}/api/v5/robotLogic/sign-token
 *      (HMAC-SHA256 signature, token cache with expiry margin, retry 10099),
 *   2. WebSocket connect to the bot gateway, AUTH_BIND (biz_id "ybBot"),
 *      wait for the bind ack (connect_id),
 *   3. inbound pushes (InboundMessagePush) with need_ack → push ACK,
 *   4. outbound via send_c2c_message / send_group_message ConnMsg frames,
 *   5. app-level ping heartbeats every 30s (2 missed pongs → reconnect).
 *
 * Configuration (settings namespace `messaging-yuanbao`):
 *   appKey:     Yuanbao bot app key (env: YUANBAO_APP_KEY)
 *   appSecret:  Yuanbao bot app secret (env: YUANBAO_APP_SECRET)
 *   apiDomain:  default https://bot.yuanbao.tencent.com (env: YUANBAO_API_DOMAIN)
 *   wsUrl:      default wss://bot-wss.yuanbao.tencent.com/wss/connection
 *   allowedUsers: sender accounts allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  reserved
 */
import z from 'schemastery'
import WebSocket from 'ws'
import { createHmac, randomUUID } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CMD,
  CMD_TYPE,
  MODULE,
  decodeAuthBindRsp,
  decodeConnMsg,
  decodeInboundPush,
  encodeAuthBind,
  encodePing,
  encodePushAck,
  encodeSendC2CMessage,
  encodeSendGroupMessage,
} from './proto.js'


const DEFAULT_API_DOMAIN = 'https://bot.yuanbao.tencent.com'
const DEFAULT_WS_URL = 'wss://bot-wss.yuanbao.tencent.com/wss/connection'
const TOKEN_PATH = '/api/v5/robotLogic/sign-token'
const HEARTBEAT_INTERVAL = 30000
const PONG_TIMEOUT = 10000
const AUTH_TIMEOUT = 15000
const RECONNECT_BACKOFF = [2000, 5000, 10000, 30000, 60000]

export function register(ctx) {
  const logger = ctx.logger('yuanbao')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-yuanbao'), z.object({
      appKey: z.string().default(''),
      appSecret: z.string().role('secret').default(''),
      apiDomain: z.string().default(''),
      wsUrl: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-yuanbao' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      appKey: (resolved.appKey && resolved.appKey.trim()) || process.env.YUANBAO_APP_KEY || '',
      appSecret: (resolved.appSecret && resolved.appSecret.trim()) || process.env.YUANBAO_APP_SECRET || '',
      apiDomain: ((resolved.apiDomain && resolved.apiDomain.trim()) || process.env.YUANBAO_API_DOMAIN || DEFAULT_API_DOMAIN).replace(/\/+$/, ''),
      wsUrl: (resolved.wsUrl && resolved.wsUrl.trim()) || process.env.YUANBAO_WS_URL || DEFAULT_WS_URL,
    }
  }

  // ---- sign-token cache ----
  let tokenCache = null

  function computeSignature(nonce, timestamp, appKey, appSecret) {
    const plain = nonce + timestamp + appKey + appSecret
    return createHmac('sha256', appSecret).update(plain, 'utf8').digest('hex')
  }

  function buildTimestamp() {
    const now = new Date()
    const offset = 8 * 60
    const bj = new Date(now.getTime() + offset * 60000)
    return bj.toISOString().slice(0, 19).replace('T', 'T') + '+08:00'
  }

  async function signToken(force = false) {
    const cfg = resolveConfig()
    if (!force && tokenCache && tokenCache.expireTs - Date.now() / 1000 > 60) {
      return tokenCache
    }
    const apiDomain = cfg.apiDomain
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const nonce = randomUUID().replace(/-/g, '')
      const timestamp = buildTimestamp()
      const signature = computeSignature(nonce, timestamp, cfg.appKey, cfg.appSecret)
      const res = await fetch(`${apiDomain}${TOKEN_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AppVersion': 'dsh-messaging',
          'X-OperationSystem': process.platform,
          'X-Instance-Id': '17',
          'X-Bot-Version': '0.1.0',
        },
        body: JSON.stringify({ app_key: cfg.appKey, nonce, signature, timestamp }),
      })
      if (!res.ok) throw new Error(`sign-token HTTP ${res.status}`)
      const data = await res.json()
      if (data.code === 0 && data.data) {
        const duration = Number(data.data.duration || 3600)
        tokenCache = {
          token: data.data.token || '',
          botId: data.data.bot_id || '',
          source: data.data.source || 'bot',
          duration,
          expireTs: Date.now() / 1000 + duration,
        }
        return tokenCache
      }
      if (data.code === 10099 && attempt < 3) {
        await sleep(1000)
        continue
      }
      throw new Error(`sign-token error: code=${data.code} msg=${data.msg || ''}`)
    }
    throw new Error('sign-token failed: max retries exceeded')
  }

  // ---- ws lifecycle ----
  let ws = null
  let connected = false
  let disposed = false
  let reconnectTimer = null
  let retries = 0
  let heartbeatTimer = null
  let missedPongs = 0
  let botId = ''
  let connectId = ''
  /** msg_id -> resolve for pending acks (ping + sends). */
  const pendingAcks = new Map()
  /** inbound msg_id dedup, bounded. */
  const seen = new Set()

  const adapter = {
    id: 'yuanbao',
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
      if (!cfg.appKey || !cfg.appSecret) {
        logger.warn('yuanbao: 未配置（settings messaging-yuanbao.appKey/appSecret 或环境变量）')
        return
      }
      try {
        const tokenData = await signToken()
        botId = tokenData.botId
        const s = new WebSocket(cfg.wsUrl)
        ws = s
        s.on('open', () => {
          doAuth(tokenData).catch((error) => {
            logger.error(`yuanbao auth failed: ${error.message}`)
            s.close()
          })
        })
        s.on('message', (raw) => {
          handleFrame(raw).catch((error) => logger.error(`yuanbao frame failed: ${error.stack || error.message}`))
        })
        s.on('close', () => {
          stopHeartbeat()
          connected = false
          adapter.connected = false
          ws = null
          failPending(new Error('yuanbao connection closed'))
          if (!disposed) scheduleReconnect()
        })
        s.on('error', (error) => logger.warn(`yuanbao ws error: ${error.message}`))
      } catch (error) {
        logger.error(`yuanbao connect failed: ${error.message}`)
        if (!disposed) scheduleReconnect()
      }
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
      connected = false
      adapter.connected = false
      failPending(new Error('yuanbao disposed'))
      if (s) {
        try {
          s.close()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!ws || !connected) throw new Error('yuanbao: not connected')
      const msgId = randomUUID()
      const msgRandom = Math.floor(Math.random() * 0x7fffffff)
      const msgSeq = Math.floor(Date.now() / 1000)
      const textSlice = text.slice(0, 4000)
      let frame
      if (target.chatId.startsWith('group:')) {
        frame = encodeSendGroupMessage(target.chatId.slice(6), botId, textSlice, msgId, msgSeq)
      } else {
        frame = encodeSendC2CMessage(target.chatId, botId, textSlice, msgId, msgRandom, msgSeq)
      }
      ws.send(frame)
      return { messageId: msgId }
    },

    async sendTyping() { /* reply heartbeats unsupported in M0 */ },

    async sendMedia() {
      throw new Error('yuanbao: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: chatId.startsWith('group:') ? 'group' : 'c2c', chatId: String(chatId) }
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
    logger.warn(`yuanbao disconnected, reconnect in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      adapter.connect().catch((error) => logger.error(`yuanbao reconnect failed: ${error.message}`))
    }, delay)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function failPending(error) {
    for (const resolve of pendingAcks.values()) resolve({ error })
    pendingAcks.clear()
  }

  /** AUTH_BIND and wait for the bind ack. */
  async function doAuth(tokenData) {
    const cfg = resolveConfig()
    const msgId = randomUUID()
    const authBytes = encodeAuthBind({
      bizId: 'ybBot',
      uid: botId || tokenData.botId,
      source: tokenData.source || 'bot',
      token: tokenData.token,
      msgId,
      appVersion: 'dsh-messaging',
      operationSystem: process.platform,
      botVersion: '0.1.0',
    })
    ws.send(authBytes)
    // The bind ack arrives as a Response frame handled by handleFrame; wait
    // for the connected flag with a timeout.
    const deadline = Date.now() + AUTH_TIMEOUT
    while (!connected && Date.now() < deadline) {
      await sleep(200)
    }
    if (!connected) throw new Error('AUTH_BIND timeout waiting for bind ack')
    logger.info(`yuanbao connected (botId=${botId}, connectId=${connectId})`)
    startHeartbeat()
  }

  /** App-level ping every 30s; 2 missed pongs → reconnect. */
  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const msgId = randomUUID()
      const promise = new Promise((resolve) => {
        pendingAcks.set(msgId, resolve)
        setTimeout(() => {
          if (pendingAcks.has(msgId)) {
            pendingAcks.delete(msgId)
            resolve({ error: new Error('pong timeout') })
          }
        }, PONG_TIMEOUT)
      })
      ws.send(encodePing(msgId))
      promise.then((result) => {
        if (result && result.error) {
          missedPongs += 1
          logger.warn(`yuanbao pong timeout (${missedPongs}/2)`)
          if (missedPongs >= 2) {
            logger.warn('yuanbao heartbeat threshold exceeded, reconnecting')
            if (ws) {
              try {
                ws.close()
              } catch { /* ignore */ }
            }
          }
        } else {
          missedPongs = 0
        }
      })
    }, HEARTBEAT_INTERVAL)
  }

  /** Frame dispatch: responses → pending acks; pushes → inbound messages. */
  async function handleFrame(raw) {
    let msg
    try {
      msg = decodeConnMsg(raw)
    } catch {
      return
    }
    const head = msg.head || {}
    const cmdType = head.cmd_type
    const cmd = head.cmd || ''

    if (cmdType === CMD_TYPE.Response) {
      if (cmd === CMD.AuthBind) {
        const rsp = decodeAuthBindRsp(msg.data)
        if (rsp.code === 0) {
          connectId = rsp.connect_id
          connected = true
          adapter.connected = true
          retries = 0
        } else {
          logger.error(`yuanbao auth-bind error: code=${rsp.code} msg=${rsp.message}`)
        }
        return
      }
      if (head.msg_id && pendingAcks.has(head.msg_id)) {
        const resolve = pendingAcks.get(head.msg_id)
        pendingAcks.delete(head.msg_id)
        resolve({})
      }
      return
    }

    if (cmdType === CMD_TYPE.Push) {
      if (head.need_ack) {
        ws.send(encodePushAck(head))
      }
      const push = decodeInboundPush(msg.data)
      if (push) await handlePush(push)
      return
    }
  }

  /** Normalize one inbound push into a messaging-core inbound event. */
  async function handlePush(push) {
    const fromAccount = String(push.from_account || '')
    if (!fromAccount || fromAccount === botId) return
    const msgId = String(push.msg_id || '')
    if (msgId) {
      if (seen.has(msgId)) return
      seen.add(msgId)
      if (seen.size > 1000) seen.delete(seen.values().next().value)
    }
    let text = ''
    for (const element of push.msg_body || []) {
      if (element && element.msg_type === 'TIMTextElem' && element.msg_content && element.msg_content.text) {
        text = String(element.msg_content.text).trim()
        break
      }
    }
    if (!text) return
    const isGroup = Boolean(push.group_code)
    const chatId = isGroup ? `group:${push.group_code}` : fromAccount
    const key = isGroup ? `group:${push.group_code}` : fromAccount

    await ctx.messaging.handleInbound('yuanbao', {
      platform: 'yuanbao',
      chatKey: `yuanbao:${key}`,
      chatId,
      userId: fromAccount,
      userName: push.sender_nickname || fromAccount,
      text,
      raw: push,
    })
  }

  const initial = resolveConfig()
  if (initial.appKey && initial.appSecret) {
    adapter.connect().catch((error) => logger.error(`yuanbao connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('yuanbao: 未配置，等待配置（settings messaging-yuanbao）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.appKey && next.appSecret && !ws) {
        adapter.connect().catch((error) => logger.error(`yuanbao connect failed: ${error.stack || error.message}`))
      }
    })
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
