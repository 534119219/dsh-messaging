/**
 * platform-whatsapp — WhatsApp messaging adapter for DSH (Baileys multi-device).
 *
 * Unofficial WhatsApp Web protocol (Baileys). First connect prints a pairing
 * QR code to the dsh web log — scan it with WhatsApp → Linked Devices.
 * Session credentials persist under $DSH_HOME/messaging/whatsapp/, so
 * restarts do not require re-pairing. Group messages require a bot mention
 * or a reply to the bot's message.
 *
 * Configuration (settings namespace `messaging-whatsapp`):
 *   enabled:      true to connect (env: WHATSAPP_ENABLED)
 *   allowedUsers: phone numbers (e.g. "8613800138000") or full jids allowed
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  reserved
 *
 * Account-ban risk: unofficial protocol — use at your own risk (same caveat
 * as hermes-agent's Baileys bridge).
 */
import z from 'schemastery'
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function normalizePhone(jid) {
  return String(jid).split('@')[0].split(':')[0]
}

export function register(ctx) {
  const logger = ctx.logger('whatsapp')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-whatsapp'), z.object({
      enabled: z.boolean().default(false),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-whatsapp' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : { enabled: false, allowedUsers: [], allowAll: false, homeChannel: '' }
    const enabled = Boolean(resolved.enabled) || process.env.WHATSAPP_ENABLED === 'true'
    return {
      ...resolved,
      enabled,
      // Normalize allowlist entries to phone numbers so core auth matches the
      // normalized inbound userId whether the user listed jids or phones.
      allowedUsers: (resolved.allowedUsers || []).map((u) => normalizePhone(u)),
    }
  }

  let sock = null
  let myJid = null
  let connecting = false
  let disposed = false
  let reconnectTimer = null
  /** Our recently sent message ids, for group reply-to-bot detection. */
  const recentSentIds = new Set()
  /** Latest Baileys pairing QR (surfaced through the QR auth flow). */
  const pairState = { qr: '', at: 0 }

  const adapter = {
    id: 'whatsapp',
    connected: false,
    capabilities: {
      streaming: false,
      typing: true,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 60000,
    },
    resolveConfig,
    /** Current pairing QR payload for the QR auth flow. */
    qrInfo() {
      return pairState.qr ? { qr: pairState.qr, at: pairState.at } : null
    },
    /** Force-connect for pairing even before the adapter is enabled. */
    startPairing() {
      return adapter.connect({ force: true })
    },

    async connect(opts = {}) {
      if (sock || connecting || disposed) return
      const cfg = resolveConfig()
      if (!cfg.enabled && !(opts && opts.force)) {
        logger.warn('whatsapp: 未启用（settings messaging-whatsapp.enabled = true）')
        return
      }
      connecting = true
      try {
        const authDir = join(dshHome(), 'messaging', 'whatsapp')
        mkdirSync(authDir, { recursive: true })
        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()
        const s = makeWASocket({
          version,
          auth: state,
          printQRInTerminal: false,
          logger: pino({ level: 'silent' }),
          browser: ['dsh-messaging', 'Chrome', '1.0'],
        })
        sock = s
        s.ev.on('creds.update', saveCreds)
        s.ev.on('connection.update', (update) => {
          handleConnectionUpdate(s, update).catch((error) => logger.error(`whatsapp connection update failed: ${error.stack || error.message}`))
        })
        s.ev.on('messages.upsert', ({ messages, type }) => {
          if (type !== 'notify') return
          for (const msg of messages || []) {
            handleMessage(msg).catch((error) => logger.error(`whatsapp message failed: ${error.stack || error.message}`))
          }
        })
        logger.info('whatsapp connecting...（首次连接请查看日志中的配对二维码）')
      } finally {
        connecting = false
      }
    },

    async disconnect() {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const s = sock
      sock = null
      myJid = null
      adapter.connected = false
      if (s) {
        try {
          s.end(new Error('disposed'))
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!sock) throw new Error('whatsapp: not connected')
      const res = await sock.sendMessage(target.chatId, { text })
      if (res && res.key && res.key.id) {
        recentSentIds.add(String(res.key.id))
        if (recentSentIds.size > 200) {
          const first = recentSentIds.values().next().value
          recentSentIds.delete(first)
        }
      }
      return { messageId: res && res.key ? String(res.key.id) : null }
    },

    async sendTyping(target) {
      if (!sock) return
      await sock.sendPresenceUpdate('composing', target.chatId)
    },

    async sendMedia() {
      throw new Error('whatsapp: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: chatId.endsWith('@g.us') ? 'group' : 'dm', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.enabled) {
    adapter.connect().catch((error) => logger.error(`whatsapp connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('whatsapp: 未启用，等待配置（settings messaging-whatsapp.enabled = true）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.enabled && !sock && !connecting) {
        adapter.connect().catch((error) => logger.error(`whatsapp connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Baileys connection lifecycle: QR -> open -> reconnect (unless logged out). */
  async function handleConnectionUpdate(s, update) {
    const { qr, connection, lastDisconnect } = update
    if (qr) {
      pairState.qr = qr
      pairState.at = Date.now()
      try {
        const ascii = await QRCode.toString(qr, { type: 'terminal', small: true })
        logger.warn(`whatsapp 配对二维码（用 WhatsApp → 已链接的设备 扫码）：\n${ascii}`)
      } catch {
        logger.warn(`whatsapp 配对二维码：${qr}`)
      }
      return
    }
    if (connection === 'open') {
      pairState.qr = ''
      myJid = s.user && s.user.id ? normalizePhone(s.user.id) + '@s.whatsapp.net' : null
      adapter.connected = true
      logger.info(`whatsapp connected (${s.user ? s.user.id : 'unknown'})`)
      return
    }
    if (connection === 'close') {
      adapter.connected = false
      const statusCode = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode : undefined
      if (disposed || statusCode === DisconnectReason.loggedOut) {
        logger.warn('whatsapp logged out — 重新配对需删除 $DSH_HOME/messaging/whatsapp 后重启')
        return
      }
      sock = null
      myJid = null
      const delay = 5000
      logger.warn(`whatsapp disconnected (code ${statusCode}), reconnect in ${delay}ms`)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        adapter.connect().catch((error) => logger.error(`whatsapp reconnect failed: ${error.message}`))
      }, delay)
    }
  }

  /** Normalize one Baileys message into a messaging-core inbound event. */
  async function handleMessage(msg) {
    if (!sock) return
    if (!msg || msg.key && msg.key.fromMe) return
    const jid = msg.key && msg.key.remoteJid
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return
    if (msg.messageStubType) return // system messages (join/leave/...)
    const content = msg.message
    if (!content || content.protocolMessage) return

    const textPart = content.conversation
      || (content.extendedTextMessage && content.extendedTextMessage.text)
      || (content.imageMessage && content.imageMessage.caption)
      || (content.videoMessage && content.videoMessage.caption)
      || (content.documentMessage && content.documentMessage.caption)
      || ''
    const hasMedia = Boolean(content.imageMessage || content.audioMessage || content.videoMessage || content.documentMessage || content.stickerMessage)
    const isGroup = jid.endsWith('@g.us')

    let text = String(textPart || '').trim()
    if (isGroup) {
      const mentioned = content.extendedTextMessage && content.extendedTextMessage.contextInfo && Array.isArray(content.extendedTextMessage.contextInfo.mentionedJid)
        ? content.extendedTextMessage.contextInfo.mentionedJid.some((m) => normalizePhone(m) === normalizePhone(myJid))
        : false
      const repliedToMe = content.extendedTextMessage && content.extendedTextMessage.contextInfo && content.extendedTextMessage.contextInfo.stanzaId
        ? recentSentIds.has(String(content.extendedTextMessage.contextInfo.stanzaId))
        : false
      if (!mentioned && !repliedToMe) return
      text = text.replace(/@\d+/g, '').trim()
    }
    if (hasMedia && !text) {
      text = '[收到媒体消息（图片/语音/视频/文件），当前版本不解析媒体内容]'
    }
    if (!text) return

    await ctx.messaging.handleInbound('whatsapp', {
      platform: 'whatsapp',
      chatKey: `whatsapp:${jid}`,
      chatId: String(jid),
      userId: normalizePhone(jid),
      userName: msg.pushName || undefined,
      text,
      raw: msg,
    })
  }
}
