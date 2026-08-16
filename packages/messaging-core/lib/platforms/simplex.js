/**
 * platform-simplex — SimpleX Chat adapter for DSH.
 *
 * Connects to a local simplex-chat daemon in WebSocket mode
 * (ws://127.0.0.1:5225 by default). Mirrors hermes-agent's simplex adapter:
 *   - inbound: newChatItems / newChatItem events (rcvMsgContent text),
 *   - outbound: structured `/_send @<contactId> json [...]` (DMs) and
 *     `/_send #<groupId> json [...]` (groups), fire-and-forget,
 *   - contact requests auto-accepted via `/accept <id>` (configurable).
 *
 * Daemon setup:
 *   simplex-chat -p 5225          # or: docker run -p 5225:5225 simplexchat/simplex-chat-cli -p 5225
 *
 * Configuration (settings namespace `messaging-simplex`):
 *   wsUrl:       daemon WS URL (default ws://127.0.0.1:5225)
 *   autoAccept:  auto-accept contact requests (default true)
 *   groupAllowed: group ids to monitor, or ["*"] for any group (default [] = groups off)
 *   allowedUsers: contactIds or display names allowed to talk to the bot
 *   allowAll:     true to accept everyone (dev only)
 *   homeChannel:  reserved
 */
import z from 'schemastery'
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('simplex')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-simplex'), z.object({
      wsUrl: z.string().default(''),
      autoAccept: z.boolean().default(true),
      groupAllowed: z.array(z.string()).default([]),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-simplex' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      wsUrl: (resolved.wsUrl && resolved.wsUrl.trim()) || process.env.SIMPLEX_WS_URL || 'ws://127.0.0.1:5225',
    }
  }

  let ws = null
  let disposed = false
  let reconnectTimer = null
  let retries = 0
  /** chat item dedup (bounded). */
  const seen = new Set()

  const adapter = {
    id: 'simplex',
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
      const s = new WebSocket(cfg.wsUrl)
      ws = s
      s.on('open', () => {
        retries = 0
        adapter.connected = true
        logger.info(`simplex connected to ${cfg.wsUrl}`)
      })
      s.on('message', (raw) => {
        handleEvent(raw).catch((error) => logger.error(`simplex event failed: ${error.stack || error.message}`))
      })
      s.on('close', () => {
        adapter.connected = false
        ws = null
        if (!disposed) scheduleReconnect()
      })
      s.on('error', (error) => logger.warn(`simplex ws error: ${error.message}`))
    },

    async disconnect() {
      disposed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const s = ws
      ws = null
      adapter.connected = false
      if (s) {
        try {
          s.close()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('simplex: not connected')
      const composed = JSON.stringify([{ msgContent: { type: 'text', text: text.slice(0, 4000) } }])
      const cmd = target.chatId.startsWith('group:')
        ? `/_send #${target.chatId.slice(6)} json ${composed}`
        : `/_send @${target.chatId} json ${composed}`
      ws.send(JSON.stringify({ corrId: `dsh_${randomUUID()}`, cmd }))
      return {}
    },

    async sendTyping() { /* SimpleX typing unsupported in M0 */ },

    async sendMedia() {
      throw new Error('simplex: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: chatId.startsWith('group:') ? 'group' : 'dm', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  function scheduleReconnect() {
    const delay = Math.min(60000, 5000 * 2 ** retries)
    retries += 1
    logger.warn(`simplex disconnected, reconnect in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      adapter.connect().catch((error) => logger.error(`simplex reconnect failed: ${error.message}`))
    }, delay)
  }

  adapter.connect().catch((error) => logger.error(`simplex connect failed: ${error.stack || error.message}`))

  /** Dispatch one daemon event. */
  async function handleEvent(raw) {
    let event
    try {
      event = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!event || typeof event !== 'object') return
    const resp = event.resp && typeof event.resp === 'object' ? event.resp : event
    const type = resp.type || event.type || ''
    if (type === 'contactRequest' && resolveConfig().autoAccept) {
      const req = resp.contactRequest || {}
      const id = req.contactRequestId
      if (id !== undefined && id !== null) {
        logger.info(`simplex auto-accepting contact request ${id}`)
        sendCmd(`/accept ${id}`)
      }
      return
    }
    if (type === 'newChatItems') {
      const items = Array.isArray(resp.chatItems) ? resp.chatItems : [resp.chatItems]
      for (const item of items) {
        if (item) await handleChatItem(item)
      }
      return
    }
    if (type === 'newChatItem') {
      await handleChatItem(resp)
    }
  }

  function sendCmd(cmd) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ corrId: `dsh_${randomUUID()}`, cmd }))
    }
  }

  /** Normalize one chat item into a messaging-core inbound event. */
  async function handleChatItem(chatItem) {
    if (!chatItem || typeof chatItem !== 'object') return
    const chatInfo = chatItem.chatInfo || {}
    const itemData = chatItem.chatItem || {}
    const meta = itemData.meta || {}
    const content = itemData.content || {}
    const chatDir = itemData.chatDir || {}
    const direction = chatDir.type || ''
    if (direction === 'directSnd' || direction === 'groupSnd') return // own messages
    if (content.type !== 'rcvMsgContent') return

    const msgContent = content.msgContent || {}
    const msgType = msgContent.type || ''
    const text = String(msgContent.text || '').trim()
    if (!text && !['image', 'file', 'voice'].includes(msgType)) return
    if (!text) return // media-only in M0

    const chatType = chatInfo.type || ''
    let chatId = ''
    let senderId = ''
    let senderName = ''
    let isGroup = false
    if (chatType === 'direct') {
      const contact = chatInfo.contact || {}
      senderId = String(contact.contactId || '')
      senderName = contact.localDisplayName || (contact.profile && contact.profile.displayName) || ''
      chatId = senderId
    } else if (chatType === 'group') {
      const groupInfo = chatInfo.groupInfo || {}
      const groupId = String(groupInfo.groupId || '')
      const cfg = resolveConfig()
      const allowed = cfg.groupAllowed || []
      if (allowed.length === 0 || (!allowed.includes('*') && !allowed.includes(groupId))) return
      chatId = `group:${groupId}`
      isGroup = true
      const member = chatDir.groupMember || {}
      senderId = String(member.memberId || '')
      senderName = member.localDisplayName || (member.memberProfile && member.memberProfile.displayName) || ''
    } else {
      return
    }
    if (!senderId) return

    const itemId = meta.itemId !== undefined ? String(meta.itemId) : ''
    if (itemId) {
      if (seen.has(itemId)) return
      seen.add(itemId)
      if (seen.size > 1000) seen.delete(seen.values().next().value)
    }

    await ctx.messaging.handleInbound('simplex', {
      platform: 'simplex',
      chatKey: `simplex:${chatId}`,
      chatId,
      userId: senderId,
      userName: senderName || senderId,
      text,
      raw: chatItem,
    })
    void isGroup
  }
}
