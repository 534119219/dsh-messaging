/**
 * platform-email — Email messaging adapter for DSH.
 *
 * IMAP polling for inbound (unseen messages addressed to the agent), SMTP for
 * outbound. One conversation per sender address; replies use "Re: <subject>"
 * of the latest inbound message (kept in an in-process map). No streaming or
 * typing.
 *
 * Configuration (settings namespace `messaging-email`):
 *   imapHost / imapPort (993) / smtpHost / smtpPort (587)
 *   address:          agent mailbox address (env: EMAIL_ADDRESS)
 *   password:         password or app-specific password (env: EMAIL_PASSWORD)
 *   pollInterval:     seconds between mailbox checks (default 15)
 *   allowedUsers:     sender addresses allowed to talk to the agent
 *   allowAll:         true to accept anyone (dev only)
 *   homeChannel:      default recipient for cron/notification delivery
 */
import z from 'schemastery'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('email')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-email'), z.object({
      imapHost: z.string().default(''),
      imapPort: z.number().default(993),
      smtpHost: z.string().default(''),
      smtpPort: z.number().default(587),
      address: z.string().default(''),
      password: z.string().role('secret').default(''),
      pollInterval: z.number().default(15),
      allowedUsers: z.array(z.string()).default([]),
      allowAll: z.boolean().default(false),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-email' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      imapHost: (resolved.imapHost && resolved.imapHost.trim()) || process.env.EMAIL_IMAP_HOST || '',
      smtpHost: (resolved.smtpHost && resolved.smtpHost.trim()) || process.env.EMAIL_SMTP_HOST || '',
      address: (resolved.address && resolved.address.trim()) || process.env.EMAIL_ADDRESS || '',
      password: (resolved.password && resolved.password.trim()) || process.env.EMAIL_PASSWORD || '',
    }
  }

  let pollTimer = null
  let polling = false
  let transporter = null
  /** chatId (sender address) -> latest inbound subject (for Re: replies). */
  const subjects = new Map()

  const adapter = {
    id: 'email',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 50000,
    },
    resolveConfig,

    async connect() {
      if (pollTimer) return
      const cfg = resolveConfig()
      if (!cfg.imapHost || !cfg.smtpHost || !cfg.address) {
        logger.warn('email: 未配置（settings messaging-email.imapHost/smtpHost/address 或环境变量）')
        return
      }
      transporter = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpPort === 465,
        auth: { user: cfg.address, pass: cfg.password },
      })
      adapter.connected = true
      logger.info(`email connected (${cfg.address})`)
      pollNow().catch((error) => logger.error(`email initial poll failed: ${error.message}`))
      pollTimer = setInterval(() => {
        pollNow().catch((error) => logger.error(`email poll failed: ${error.message}`))
      }, Math.max(5, cfg.pollInterval || 15) * 1000)
    },

    async disconnect() {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      adapter.connected = false
    },

    async send(target, text) {
      const cfg = resolveConfig()
      if (!transporter) throw new Error('email: not connected')
      const to = String(target.chatId)
      const subject = subjects.get(to) ? `Re: ${subjects.get(to)}` : 'Re: 你的消息'
      await transporter.sendMail({ from: cfg.address, to, subject, text })
      return {}
    },

    async sendTyping() { /* email has no typing */ },

    async sendMedia() {
      throw new Error('email: media unsupported (M0)')
    },

    async getChatInfo(chatId) {
      return { name: String(chatId), type: 'email', chatId: String(chatId) }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.imapHost && initial.smtpHost && initial.address) {
    adapter.connect().catch((error) => logger.error(`email connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('email: 未配置，等待配置（settings messaging-email）')
  }

  /** One mailbox sweep: unseen messages addressed to the agent -> inbound. */
  async function pollNow() {
    if (polling) return
    polling = true
    const cfg = resolveConfig()
    let client
    try {
      client = new ImapFlow({
        host: cfg.imapHost,
        port: cfg.imapPort,
        secure: cfg.imapPort === 993,
        auth: { user: cfg.address, pass: cfg.password },
        logger: false,
      })
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        for await (const message of client.fetch({ seen: false }, { uid: true, envelope: true, source: true })) {
          await processMessage(client, message, cfg)
        }
      } finally {
        lock.release()
      }
    } catch (error) {
      logger.warn(`email poll error: ${error.message}`)
    } finally {
      if (client) {
        try {
          await client.logout()
        } catch { /* ignore */ }
      }
      polling = false
    }
  }

  /** Normalize one email into a messaging-core inbound event; marks seen. */
  async function processMessage(client, message, cfg) {
    try {
      const parsed = message.source
      const from = firstAddress(parsed.headers.get('from'))
      const tos = [...(parsed.headers.get('to') || [])].map(addressToString)
      const delivered = [...(parsed.headers.get('delivered-to') || [])]
      const addressed = tos.some((t) => t.toLowerCase() === cfg.address.toLowerCase()) || delivered.some((t) => t.toLowerCase().includes(cfg.address.toLowerCase()))
      if (!from || !addressed) return
      if (from.toLowerCase() === cfg.address.toLowerCase()) return // self

      const subject = String(parsed.subject || '(无主题)').trim()
      const text = extractText(parsed)
      if (!text) return

      // Mark seen before dispatching so a crash does not re-deliver.
      if (message.uid) {
        try {
          await client.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true })
        } catch { /* ignore */ }
      }

      const key = from.toLowerCase()
      subjects.set(key, subject)
      await ctx.messaging.handleInbound('email', {
        platform: 'email',
        chatKey: `email:${key}`,
        chatId: key,
        userId: from,
        userName: from,
        text: `主题：${subject}\n\n${text}`,
        raw: { from, subject },
      })
    } catch (error) {
      logger.warn(`email message processing failed: ${error.message}`)
    }
  }
}

function firstAddress(value) {
  if (!value) return ''
  const addr = Array.isArray(value) ? value[0] : value
  return addressToString(addr)
}

function addressToString(addr) {
  if (!addr) return ''
  if (typeof addr === 'string') return addr
  if (addr.address) return String(addr.address)
  return String(addr)
}

/** Extract plain text; fall back to stripping HTML. */
function extractText(parsed) {
  const walk = (node, depth) => {
    if (depth > 6) return null
    if (!node) return null
    const ctype = String(node.contentType || '').toLowerCase()
    if (ctype.startsWith('text/plain')) {
      const buf = node.content || ''
      return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
    }
    if (ctype.startsWith('multipart/')) {
      for (const child of node.childNodes || []) {
        const found = walk(child, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  const plain = walk(parsed, 0)
  if (plain) return plain.trim().slice(0, 4000)
  // HTML fallback
  const htmlNode = (() => {
    const find = (node, depth) => {
      if (depth > 6 || !node) return null
      if (String(node.contentType || '').toLowerCase().startsWith('text/html')) return node
      for (const child of node.childNodes || []) {
        const found = find(child, depth + 1)
        if (found) return found
      }
      return null
    }
    return find(parsed, 0)
  })()
  if (htmlNode) {
    const html = (Buffer.isBuffer(htmlNode.content) ? htmlNode.content.toString('utf8') : String(htmlNode.content || '')).trim().slice(0, 8000)
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000)
  }
  return ''
}
