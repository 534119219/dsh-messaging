/**
 * platform-weixin — WeChat personal-account adapter for DSH (Tencent iLink
 * Bot API). Mirrors hermes-agent's weixin adapter protocol:
 *   - long-poll POST ilink/bot/getupdates (continuation cursor persisted),
 *   - outbound POST ilink/bot/sendmessage echoing the peer's context_token,
 *   - errcode -14 / "unknown error" -2 = session expired → long backoff.
 *
 * Pairing (QR login) is a standalone wizard: node weixin-pair.mjs.
 *
 * Configuration (settings namespace `messaging-weixin`):
 *   accountId: iLink bot account id (env: WEIXIN_ACCOUNT_ID)
 *   token:     iLink bot token (env: WEIXIN_TOKEN)
 *   baseUrl:   default https://ilinkai.weixin.qq.com
 *   allowedUsers: peer ids allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  reserved
 *
 * Account-ban risk: unofficial protocol — use at your own risk.
 */
import z from 'schemastery'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.2.0'
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0)

const EP_GET_UPDATES = 'ilink/bot/getupdates'
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'

const LONG_POLL_TIMEOUT_MS = 35000
const API_TIMEOUT_MS = 15000
const SESSION_EXPIRED_ERRCODE = -14

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function register(ctx) {
  const logger = ctx.logger('weixin')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-weixin'), z.object({
      accountId: z.string().default(''),
      token: z.string().role('secret').default(''),
      baseUrl: z.string().default(''),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-weixin' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      accountId: (resolved.accountId && resolved.accountId.trim()) || process.env.WEIXIN_ACCOUNT_ID || '',
      token: (resolved.token && resolved.token.trim()) || process.env.WEIXIN_TOKEN || '',
      baseUrl: ((resolved.baseUrl && resolved.baseUrl.trim()) || process.env.WEIXIN_BASE_URL || ILINK_BASE_URL).replace(/\/+$/, ''),
    }
  }

  const stateFile = join(dshHome(), 'messaging', 'weixin-state.json')
  /** peerId -> context_token (persisted across restarts). */
  let contextTokens = {}
  let syncBuf = ''
  let polling = false
  let stop = false
  let pollTimer = null
  /** message_id dedup, bounded. */
  const seen = new Set()

  function loadState() {
    try {
      if (existsSync(stateFile)) {
        const data = JSON.parse(readFileSync(stateFile, 'utf8'))
        contextTokens = data.contextTokens || {}
        syncBuf = data.syncBuf || ''
      }
    } catch { /* ignore */ }
  }

  function saveState() {
    try {
      mkdirSync(join(stateFile, '..'), { recursive: true })
      writeFileSync(stateFile, JSON.stringify({ contextTokens, syncBuf }), 'utf8')
    } catch { /* ignore */ }
  }

  const adapter = {
    id: 'weixin',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 2000,
    },
    resolveConfig,

    async connect() {
      if (polling) return
      const cfg = resolveConfig()
      if (!cfg.accountId || !cfg.token) {
        logger.warn('weixin: 未配置（settings messaging-weixin.accountId/token 或环境变量）；先用 node D:\\Harness\\messaging\\weixin-pair.mjs 扫码配对')
        return
      }
      loadState()
      polling = true
      stop = false
      adapter.connected = true
      logger.info(`weixin polling (account ${cfg.accountId.slice(0, 6)}...)`)
      pollLoop().catch((error) => logger.error(`weixin poll loop failed: ${error.stack || error.message}`))
    },

    async disconnect() {
      stop = true
      polling = false
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      adapter.connected = false
    },

    async send(target, text) {
      const cfg = resolveConfig()
      const peer = target.chatId
      const contextToken = contextTokens[peer] || ''
      const clientId = randomUUID()
      const body = {
        msg: {
          from_user_id: '',
          to_user_id: peer,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      }
      const data = await apiPost(cfg, EP_SEND_MESSAGE, body)
      const errcode = data && (data.errcode ?? data.ret)
      if (errcode === SESSION_EXPIRED_ERRCODE) {
        logger.warn('weixin: session expired (errcode -14)')
      }
      return {}
    },

    async sendTyping() { /* weixin typing needs a per-peer typing ticket — M0 skip */ },

    async sendMedia() {
      throw new Error('weixin: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'weixin-dm', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.accountId && initial.token) {
    adapter.connect().catch((error) => logger.error(`weixin connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('weixin: 未配置，等待配置（settings messaging-weixin）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.accountId && next.token && !polling) {
        adapter.connect().catch((error) => logger.error(`weixin connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** iLink POST: compact JSON body + bot headers. */
  async function apiPost(cfg, endpoint, payload, timeoutMs = API_TIMEOUT_MS) {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } })
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(body)),
      'X-WECHAT-UIN': randomUUID().replace(/-/g, '').slice(0, 16),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${cfg.baseUrl}/${endpoint}`, { method: 'POST', headers, body, signal: controller.signal })
      if (!res.ok) throw new Error(`iLink POST ${endpoint} HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Long-poll getupdates; dispatch messages; persist the cursor. */
  async function pollLoop() {
    let consecutiveFailures = 0
    while (!stop) {
      try {
        const cfg = resolveConfig()
        const data = await apiPost(cfg, EP_GET_UPDATES, { get_updates_buf: syncBuf }, LONG_POLL_TIMEOUT_MS)
        const ret = data && (data.ret ?? data.errcode)
        const errmsg = data && data.errmsg ? String(data.errmsg) : ''
        if (ret && ret !== 0) {
          if (ret === SESSION_EXPIRED_ERRCODE || (ret === -2 && errmsg.toLowerCase() === 'unknown error')) {
            logger.error('weixin: session expired, backing off 10min（重新配对请运行 weixin-pair.mjs）')
            consecutiveFailures = 0
            await sleep(600000)
            continue
          }
          consecutiveFailures += 1
          logger.warn(`weixin getupdates failed ret=${ret} errmsg=${errmsg} (${consecutiveFailures}/3)`)
          await sleep(consecutiveFailures >= 3 ? 30000 : 2000)
          if (consecutiveFailures >= 3) consecutiveFailures = 0
          continue
        }
        consecutiveFailures = 0
        const newBuf = data && data.get_updates_buf ? String(data.get_updates_buf) : ''
        if (newBuf) {
          syncBuf = newBuf
          saveState()
        }
        for (const message of (data && data.msgs) || []) {
          await handleMessage(message)
        }
      } catch (error) {
        if (error && error.name === 'AbortError') continue // long-poll timeout = empty
        consecutiveFailures += 1
        logger.warn(`weixin poll error: ${error.message} (${consecutiveFailures}/3)`)
        await sleep(consecutiveFailures >= 3 ? 30000 : 2000)
        if (consecutiveFailures >= 3) consecutiveFailures = 0
      }
    }
    adapter.connected = false
  }

  /** Normalize one iLink message into a messaging-core inbound event. */
  async function handleMessage(message) {
    if (!message || typeof message !== 'object') return
    const cfg = resolveConfig()
    const senderId = String(message.from_user_id || '').trim()
    if (!senderId || senderId === cfg.accountId) return
    const messageId = String(message.message_id || '').trim()
    if (messageId) {
      if (seen.has(messageId)) return
      seen.add(messageId)
      if (seen.size > 1000) seen.delete(seen.values().next().value)
    }
    const itemList = Array.isArray(message.item_list) ? message.item_list : []
    let text = ''
    for (const item of itemList) {
      if (item && item.type === 1 && item.text_item && typeof item.text_item.text === 'string') {
        text = item.text_item.text.trim()
        break
      }
    }
    if (!text) return
    const contextToken = String(message.context_token || '').trim()
    if (contextToken) {
      contextTokens[senderId] = contextToken
      saveState()
    }

    await ctx.messaging.handleInbound('weixin', {
      platform: 'weixin',
      chatKey: `weixin:${senderId}`,
      chatId: senderId,
      userId: senderId,
      userName: senderId,
      text,
      raw: message,
    })
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
