/**
 * messaging-core — DSH messaging gateway core.
 *
 * Provides the `ctx.messaging` service:
 *   - registerAdapter()          — platform adapters register here
 *   - handleInbound(platform, e) — authorization + slash commands + agent
 *                                  dispatch (followup/steer) for inbound chat
 *                                  messages
 *   - send(platform, chat, text) — programmatic sends (send_message tool)
 *   - formatText(text, platform) — markdown rendering per adapter capability
 *   - status()                   — overview for the messaging_status tool
 *
 * Also wires the outbound router (session/event -> adapters) and registers
 * the messaging tools. Platform packages (platform-telegram, ...) depend on
 * this plugin via `inject: ['messaging', ...]`.
 */
import z from 'schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createSessionMap } from './session-map.js'
import { createAgentManager } from './agents.js'
import { createOutboundRouter } from './outbound.js'
import { registerMessagingTools } from './tools.js'
import { renderForCapability, markdownToHtml } from './markdown.js'
import { createWebhookServer } from './http.js'
import { createQrManager } from './qr.js'
import { PLATFORM_CATALOG } from './config.js'
// Platform adapters live inside this single plugin (consolidated from the
// former per-platform Cordis bundles); each module registers its settings
// namespace and adapter against the shared `messaging` service.
import { register as registerTelegram } from './platforms/telegram.js'
import { register as registerDiscord } from './platforms/discord.js'
import { register as registerSlack } from './platforms/slack.js'
import { register as registerIrc } from './platforms/irc.js'
import { register as registerNtfy } from './platforms/ntfy.js'
import { register as registerEmail } from './platforms/email.js'
import { register as registerMatrix } from './platforms/matrix.js'
import { register as registerHomeassistant } from './platforms/homeassistant.js'
import { register as registerSignal } from './platforms/signal.js'
import { register as registerWhatsapp } from './platforms/whatsapp.js'
import { register as registerFeishu } from './platforms/feishu.js'
import { register as registerMattermost } from './platforms/mattermost.js'
import { register as registerQq } from './platforms/qq.js'
import { register as registerLine } from './platforms/line.js'
import { register as registerSms } from './platforms/sms.js'
import { register as registerWhatsappcloud } from './platforms/whatsappcloud.js'
import { register as registerWecom } from './platforms/wecom.js'
import { register as registerTeams } from './platforms/teams.js'
import { register as registerDingtalk } from './platforms/dingtalk.js'
import { register as registerGooglechat } from './platforms/googlechat.js'
import { register as registerWebhook } from './platforms/webhook.js'
import { register as registerA2a } from './platforms/a2a.js'
import { register as registerWeixin } from './platforms/weixin.js'
import { register as registerBluebubbles } from './platforms/bluebubbles.js'
import { register as registerApiServer } from './platforms/api-server.js'
import { register as registerYuanbao } from './platforms/yuanbao.js'
import { register as registerSimplex } from './platforms/simplex.js'

export const name = 'messaging-core'
export const inject = ['agents', 'sessions', 'settings', 'tools']

export function apply(ctx) {
  const logger = ctx.logger('messaging')
  const sessionMap = createSessionMap({ logger })
  const agentManager = createAgentManager(ctx, { logger })
  /** platform id -> adapter */
  const adapters = new Map()
  /** Rolling inbound diagnostics (last 5), surfaced by /messaging/status. */
  const inboundLog = []

  let globalScope
  try {
    globalScope = ctx.settings.register(settingsNamespace('messaging'), z.object({
      homeChannel: z.string().default(''),
      httpPort: z.number().default(8765),
      httpHost: z.string().default('127.0.0.1'),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging' unavailable: ${error.message}`)
  }

  /** Lazily-started shared webhook listener for webhook-type platforms. */
  let webhookServer = null
  function webhooks() {
    if (!webhookServer) {
      const cfg = globalScope ? globalScope.get() : { httpPort: 8765, httpHost: '127.0.0.1' }
      webhookServer = createWebhookServer(ctx, {
        logger,
        port: Number(cfg.httpPort) || 8765,
        host: cfg.httpHost || '127.0.0.1',
      })
    }
    return webhookServer
  }

  // -------------------------------------------------------- slash commands

  function liveAgent(sessionId) {
    try {
      return ctx.agents.get(sessionId) || null
    } catch {
      return null
    }
  }

  /** Live-session title via the sessionTitle service ('' when unavailable). */
  function sessionTitleOf(agent) {
    if (!agent || !agent.session) return ''
    const sessionTitle = ctx.get && ctx.get('sessionTitle')
    if (!sessionTitle) return ''
    try {
      const snap = sessionTitle.get(agent.session)
      return snap ? snap.title : ''
    } catch {
      return ''
    }
  }

  /** /title [标题] — show or set the current session title (hermes semantics). */
  async function runTitle(platform, chatKey, sessionId, arg) {
    const sessionTitle = ctx.get && ctx.get('sessionTitle')
    if (!sessionTitle) return '⚠️ 当前环境不支持设置标题。'
    let agent = liveAgent(sessionId)
    if (arg && !agent) {
      // Commands run before the chat is touched, so a fresh chat has no
      // session yet — create it on demand so /title works as the first
      // message.
      try {
        const platformMeta = PLATFORM_CATALOG[platform]
        sessionMap.touch(chatKey, { platform })
        agent = await agentManager.ensureAgent(sessionId, {
          platform,
          label: platformMeta ? platformMeta.label : platform,
          cwd: agentManager.workspaceFor(platform),
        })
      } catch (error) {
        return `⚠️ 创建会话失败：${error.message}`
      }
    }
    const session = agent && agent.session
    if (arg) {
      if (!session) return '⚠️ 会话尚未创建，请先发一条消息再设置标题。'
      try {
        const snap = sessionTitle.rename(session, arg)
        sessionMap.setHistoryTitle(chatKey, sessionId, snap.title)
        return `✅ 标题已设为：${snap.title}`
      } catch (error) {
        return `⚠️ 设置标题失败：${error.message}`
      }
    }
    const title = sessionTitleOf(agent)
    if (title) sessionMap.setHistoryTitle(chatKey, sessionId, title)
    return title
      ? `📋 当前标题：${title}\n（/title 新标题 可修改）`
      : `🆔 会话：${sessionId}\n（暂无标题，发送 /title 新标题 设置）`
  }

  /** /resume [序号] — list (by title) or switch to a previous session. */
  async function runResume(chatKey, sessionId, arg) {
    const hist = sessionMap.historyFor(chatKey)
    const titleFor = (h) => {
      if (h.title) return h.title
      const title = sessionTitleOf(liveAgent(h.sessionId))
      if (title) sessionMap.setHistoryTitle(chatKey, h.sessionId, title)
      return title
    }
    if (!arg) {
      if (!hist.length) return '📭 还没有历史会话。'
      const lines = hist.map((h, i) => {
        const t = new Date(h.updatedAt || 0)
        const ts = t.getTime()
          ? `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
          : ''
        const mark = h.sessionId === sessionId ? ' ← 当前' : ''
        const label = titleFor(h) || '未命名'
        return `${i + 1}. ${label}${mark}${ts ? `（${ts}）` : ''}`
      })
      return `📚 历史会话（/resume 序号 切换）：\n${lines.join('\n')}`
    }
    let targetId = null
    let targetTitle = ''
    if (/^\d+$/.test(arg)) {
      const hit = hist[Number(arg) - 1]
      if (hit) {
        targetId = hit.sessionId
        targetTitle = titleFor(hit)
      }
    } else {
      // Advanced: switch by exact session id.
      const hit = hist.find((h) => h.sessionId === arg)
      if (hit) {
        targetId = hit.sessionId
        targetTitle = titleFor(hit)
      }
    }
    if (!targetId) return '⚠️ 找不到该会话，发送 /resume 查看列表。'
    if (targetId === sessionId) return '✅ 已在当前会话。'
    sessionMap.resume(chatKey, targetId)
    return `✅ 已切换到「${targetTitle || '该会话'}」，后续消息将发往该会话。`
  }

  /** /status — session/model/platform overview (hermes cockpit-style). */
  async function runStatus(platform, chatKey, sessionId) {
    const entry = sessionMap.entryFor(chatKey)
    const agent = liveAgent(sessionId)
    const defaults = ctx.get && ctx.get('agentDefaultModel')
    let sel = null
    try {
      sel = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : null
    } catch { /* ignore */ }
    const connected = [...adapters.values()].filter((a) => a.connected).map((a) => a.id)
    // Title first (live session title, else cached history title), falling
    // back to 未命名; the raw session id is intentionally not shown.
    let title = sessionTitleOf(agent)
    if (!title) {
      const hist = sessionMap.historyFor(chatKey)
      const current = hist[hist.length - 1]
      title = current && current.title ? current.title : ''
    }
    if (title) sessionMap.setHistoryTitle(chatKey, sessionId, title)
    const lines = [
      '📊 消息平台状态',
      `📝 标题：${title || '未命名'}`,
      `📱 平台：${platform}${entry && entry.chatId ? ` · ${entry.chatId}` : ''}`,
    ]
    if (entry && entry.userId) lines.push(`👤 用户：${entry.userId}`)
    if (sel) {
      lines.push(`🤖 模型：${sel.provider} / ${sel.model}${sel.reasoningEffort ? `（${sel.reasoningEffort}）` : ''}`)
    }
    lines.push(`⚡ Agent：${agent ? (agent.status === 'running' ? '运行中' : '空闲') : '未创建'}`)
    if (agent && agent.session && Array.isArray(agent.session.events)) {
      const count = agent.session.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').length
      lines.push(`💬 消息数：${count}`)
    }
    lines.push(`🔌 已连接平台：${connected.length ? connected.join(', ') : '（无）'}`)
    lines.push(`📂 工作区：${agentManager.workspaceFor(platform)}`)
    return lines.join('\n')
  }

  const api = {
    registerAdapter(adapter) {
      if (!adapter || !adapter.id || adapters.has(adapter.id)) {
        throw new Error(`messaging: adapter '${adapter && adapter.id}' already registered or invalid`)
      }
      adapters.set(adapter.id, adapter)
      logger.info(`platform adapter registered: ${adapter.id}`)
      return () => {
        adapters.delete(adapter.id)
        logger.info(`platform adapter unregistered: ${adapter.id}`)
      }
    },

    getAdapter(id) {
      return adapters.get(id)
    },

    listAdapters() {
      return [...adapters.values()]
    },

    formatText(text, platform) {
      const adapter = adapters.get(platform)
      if (adapter && adapter.capabilities && adapter.capabilities.markdown === 'html') {
        return markdownToHtml(text)
      }
      return text
    },

    async send(platform, chatId, text) {
      const adapter = adapters.get(platform)
      if (!adapter) throw new Error(`未知平台: ${platform}`)
      const rendered = renderForCapability(String(text), adapter.capabilities)
      return adapter.send({ chatId: String(chatId) }, rendered)
    },

    status() {
      return [...adapters.values()].map((adapter) => ({
        id: adapter.id,
        connected: Boolean(adapter.connected),
        detail: typeof adapter.detail === 'function' ? adapter.detail() : (adapter.detail || ''),
      }))
    },

    /** Register a webhook route on the shared listener (starts it lazily). */
    registerWebhook(path, handler) {
      return webhooks().register(path, handler)
    },

    /** Rolling inbound diagnostics (last 5), surfaced by /messaging/status. */
    diagnostics() {
      return inboundLog
    },

    /** Authorize, interpret slash commands, and dispatch one inbound message. */
    async handleInbound(platform, event) {
      const adapter = adapters.get(platform)
      if (!adapter) {
        logger.warn(`inbound from unregistered platform: ${platform}`)
        return
      }
      const target = { chatId: event.chatId, threadId: event.threadId }
      const rec = (outcome, extra) => {
        inboundLog.unshift({
          platform,
          at: Date.now(),
          userId: String(event.userId || ''),
          chatId: String(event.chatId || ''),
          text: String(event.text || '').slice(0, 40),
          outcome,
          ...(extra || {}),
        })
        if (inboundLog.length > 5) inboundLog.pop()
      }
      rec('received')
      try {
        const cfg = adapter.resolveConfig ? adapter.resolveConfig() : {}
        const allowAll = Boolean(cfg.allowAll)
        const allowed = allowAll || (Array.isArray(cfg.allowedUsers) && cfg.allowedUsers.some((u) => String(u) === String(event.userId)))
        if (!allowed) {
          logger.warn(`unauthorized ${platform} message from user ${event.userId} in chat ${event.chatId}`)
          rec('unauthorized')
          try {
            await adapter.send(target, '⚠️ 未授权：你的账号不在允许列表中，无法使用本机器人。')
          } catch (error) {
            rec('unauthorized-send-failed', { error: error.message })
          }
          return
        }

        const text = String(event.text || '').trim()
        if (!text) {
          rec('empty')
          return
        }

        if (text.startsWith('/')) {
          const cmd = text.split(/\s/)[0]
          const arg = text.slice(cmd.length).trim()
          const sessionId = sessionMap.sessionIdFor(event.chatKey)
          let reply
          if (cmd === '/new') {
            await agentManager.disposeAgent(sessionId)
            sessionMap.reset(event.chatKey)
            rec('slash-new')
            reply = '✅ 已开启新会话。'
          } else if (cmd === '/stop') {
            const agent = ctx.agents.get(sessionId)
            if (agent) agent.cancel({ kind: 'user' })
            rec('slash-stop')
            reply = '⏹ 已中断当前任务。'
          } else if (cmd === '/title') {
            rec('slash-title')
            reply = await runTitle(platform, event.chatKey, sessionId, arg)
          } else if (cmd === '/resume') {
            rec('slash-resume')
            reply = await runResume(event.chatKey, sessionId, arg)
          } else if (cmd === '/status') {
            rec('slash-status')
            reply = await runStatus(platform, event.chatKey, sessionId)
          } else {
            rec('slash-unknown')
            reply = `未知命令：${cmd}（支持 /new /stop /title /resume /status）`
          }
          await adapter.send(target, reply)
          return
        }

        const entry = sessionMap.touch(event.chatKey, {
          platform,
          chatId: event.chatId,
          threadId: event.threadId,
          userId: event.userId,
          userName: event.userName,
        })
        rec('mapped', { sessionId: entry.sessionId })

        const platformMeta = PLATFORM_CATALOG[platform]
        const agent = await agentManager.ensureAgent(entry.sessionId, {
          platform,
          label: platformMeta ? platformMeta.label : platform,
          cwd: agentManager.workspaceFor(platform),
        })
        rec('agent-ready', { sessionId: entry.sessionId })
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          // kind 'user' renders as a normal user bubble in the web UI; the
          // platform/chat/user fields keep provenance for the outbound router.
          source: { kind: 'user', platform, chatKey: event.chatKey, userId: event.userId },
        })
        if (agent.status === 'running') agent.steer(message)
        else agent.followup(message)
        rec('dispatched', { sessionId: entry.sessionId })
        logger.info(`inbound ${platform} user=${event.userId} -> ${entry.sessionId}: ${text.slice(0, 80)}`)
      } catch (error) {
        logger.error(`inbound failed on ${platform}: ${error.stack || error.message}`)
        rec('error', { error: error.message })
        try {
          await adapter.send(target, '⚠️ 处理消息时出错，请稍后重试。')
        } catch { /* ignore */ }
      }
    },
  }

  ctx.provide('messaging', api)

  // Register every consolidated platform adapter. Each registrar owns its
  // settings namespace + adapter lifecycle; failures are contained so one
  // broken platform cannot take the gateway down.
  const registrars = [
    registerTelegram, registerDiscord, registerSlack, registerIrc, registerNtfy,
    registerEmail, registerMatrix, registerHomeassistant, registerSignal,
    registerWhatsapp, registerFeishu, registerMattermost, registerQq,
    registerLine, registerSms, registerWhatsappcloud, registerWecom,
    registerTeams, registerDingtalk, registerGooglechat, registerWebhook,
    registerA2a, registerWeixin, registerBluebubbles, registerApiServer,
    registerYuanbao, registerSimplex,
  ]
  for (const registrar of registrars) {
    try {
      registrar(ctx)
    } catch (error) {
      logger.warn(`platform registrar failed: ${error.message}`)
    }
  }

  const router = createOutboundRouter(ctx, { adapters, sessionMap, logger })
  ctx.on('session/event', (session, event) => router.onSessionEvent(session, event))
  ctx.on('dispose', () => {
    router.dispose()
    if (webhookServer) webhookServer.stop()
    agentManager.disposeAll().catch((error) => logger.warn(`agent teardown failed: ${error.message}`))
  })

  // Status endpoint for the client UI: prefer the web app's own server
  // (same origin, no CORS), fall back to the loopback listener.
  function statusJson() {
    const platforms = [...adapters.values()].map((adapter) => ({
      id: adapter.id,
      connected: Boolean(adapter.connected),
      detail: typeof adapter.detail === 'function' ? adapter.detail() : (adapter.detail || ''),
      capabilities: adapter.capabilities ? {
        streaming: Boolean(adapter.capabilities.streaming),
        typing: Boolean(adapter.capabilities.typing),
        markdown: adapter.capabilities.markdown || 'plain',
      } : {},
    }))
    const chats = sessionMap.entries().map((entry) => ({
      platform: entry.chatKey.split(':')[0],
      chatId: entry.chatId,
      userName: entry.userName,
      sessionId: entry.sessionId,
      updatedAt: entry.updatedAt,
    }))
    return { platforms, chats, diagnostics: inboundLog }
  }
  const handleStatus = ({ res, method }) => {
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(statusJson()))
  }
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      webServer.register({
        kind: 'prefix',
        path: '/messaging/status',
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req, webServerTrustedHosts(ctx))) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
            return
          }
          handleStatus({ res, method: req.method })
        },
      })
      logger.info('messaging status endpoint ready at /messaging/status (web server)')
    } catch (error) {
      logger.warn(`webServer status route failed, falling back to loopback: ${error.message}`)
      try {
        webhooks().register('/messaging/status', handleStatus)
      } catch (e2) { /* ignore */ }
    }
  } else {
    try {
      webhooks().register('/messaging/status', handleStatus)
      logger.info('messaging status endpoint ready at /messaging/status (loopback listener)')
    } catch (error) {
      logger.warn(`status route registration failed: ${error.message}`)
    }
  }

  // ---- setup/config endpoints (web server, same-origin, fenced) ----
  const configRoute = {
    kind: 'prefix',
    path: '/messaging/config',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, webServerTrustedHosts(ctx))) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(buildConfigPayload()))
        return
      }
      if (req.method === 'POST') {
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          await handleConfigPost(JSON.parse(Buffer.concat(chunks).toString('utf8')), res)
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
        }
        return
      }
      res.writeHead(405)
      res.end()
    },
  }
  if (webServer && typeof webServer.register === 'function') {
    try {
      webServer.register(configRoute)
      logger.info('messaging config endpoint ready at /messaging/config (web server)')
    } catch (error) {
      logger.warn(`webServer config route failed: ${error.message}`)
    }
  }

  // ---- QR scan-to-authorize endpoints (web server, same-origin, fenced) ----
  const qrManager = createQrManager(ctx, { logger, getAdapter: (id) => adapters.get(id) })
  const qrRoute = {
    kind: 'prefix',
    path: '/messaging/qr',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, webServerTrustedHosts(ctx))) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
        return
      }
      try {
        const url = new URL(req.url || '', 'http://localhost')
        if (req.method === 'POST' && url.pathname.endsWith('/start')) {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          const platform = String((body && body.platform) || '')
          const started = await qrManager.start(platform)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, ...started }))
          return
        }
        if (req.method === 'GET' && url.pathname.endsWith('/status')) {
          const task = url.searchParams.get('task')
          if (!task) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'missing task' }))
            return
          }
          const result = await qrManager.status(task)
          res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
          return
        }
        res.writeHead(405)
        res.end()
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
      }
    },
  }
  if (webServer && typeof webServer.register === 'function') {
    try {
      webServer.register(qrRoute)
      logger.info('messaging qr endpoints ready at /messaging/qr (web server)')
    } catch (error) {
      logger.warn(`webServer qr route failed: ${error.message}`)
    }
  }

  /** Catalog-driven secret redaction (no raw secrets leave the host). */
  // (module-level `redactSecrets` used below)

  /** Catalog + redacted resolved values for every messaging namespace. */
  function buildConfigPayload() {
    const platforms = {}
    for (const [id, meta] of Object.entries(PLATFORM_CATALOG)) {
      platforms[id] = {
        label: meta.label,
        note: meta.note || '',
        qr: Boolean(meta.qr),
        fields: meta.fields.map((f) => ({
          key: f.key,
          label: f.label,
          secret: Boolean(f.secret),
          required: Boolean(f.required),
          type: f.type || 'string',
          default: f.default !== undefined ? f.default : null,
        })),
      }
    }
    const values = {}
    for (const id of Object.keys(PLATFORM_CATALOG)) {
      try {
        const resolved = ctx.settings.get(settingsNamespace(`messaging-${id}`))
        if (resolved !== undefined && resolved !== null) {
          values[`messaging-${id}`] = redactSecrets(resolved, PLATFORM_CATALOG[id].fields)
        }
      } catch { /* unregistered — skip */ }
    }
    return { platforms, values }
  }

  /** Validate + persist one platform's patch through the settings service. */
  async function handleConfigPost(body, res) {
    const id = String((body && body.platform) || '')
    const patch = body && body.patch
    const meta = PLATFORM_CATALOG[id]
    if (!meta || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid platform or patch' }))
      return
    }
    const clean = cleanConfigPatch(patch, meta)
    if (Object.keys(clean).length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, unchanged: true }))
      return
    }
    await ctx.settings.update(settingsNamespace(`messaging-${id}`), clean)
    logger.info(`messaging config updated: ${id} (${Object.keys(clean).join(', ')})`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  }

  registerMessagingTools(ctx, { adapters, sessionMap })

  const home = globalScope ? globalScope.get().homeChannel : ''
  logger.info(`messaging-core ready (homeChannel=${home || 'unset'})`)
}

/** Loopback/trusted-host + same-origin fence for web-server routes (ported from chicheng-push). */
function header(headers, name) {
  const value = headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function parseAuthority(value) {
  try {
    const url = new URL(`http://${String(value)}`)
    if (!url.hostname) return undefined
    return { hostname: url.hostname.toLowerCase(), port: url.port || '' }
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const hosts = Array.isArray(trustedHosts) ? trustedHosts : []
  const trusted = hosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return entryUrl.hostname === hostUrl.hostname && (entryUrl.port === '' || entryUrl.port === hostUrl.port)
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    // Compare hostname + port explicitly (the origin URL's `.host` includes
    // the port while parseAuthority returns hostname/port separately).
    const originUrl = new URL(origin)
    if (originUrl.hostname !== hostUrl.hostname) return false
    if (hostUrl.port !== '' && originUrl.port !== hostUrl.port) return false
    return true
  } catch {
    return false
  }
}

function webServerTrustedHosts(ctx) {
  const runtime = ctx.get('webRuntime')
  return (runtime && runtime.trustedHosts) || []
}

/** Catalog-driven secret redaction (no raw secrets leave the host). */
export function redactSecrets(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = { ...value }
  for (const field of fields) {
    if (field.secret && out[field.key] !== undefined && out[field.key] !== '') {
      out[field.key] = { __redacted__: true }
    }
  }
  return out
}

/**
 * Whitelist + coerce one platform patch against its catalog entry:
 * unknown keys dropped, empty/still-redacted secrets preserved, and
 * list/bool/number types normalized for the settings schema.
 */
export function cleanConfigPatch(patch, meta) {
  const clean = {}
  for (const field of meta.fields) {
    const value = patch[field.key]
    if (value === undefined) continue
    // Empty or still-redacted secrets are left untouched.
    if (field.secret && (value === '' || (value && typeof value === 'object' && value.__redacted__))) continue
    if (field.type === 'list') {
      clean[field.key] = Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean)
    } else if (field.type === 'bool') {
      clean[field.key] = value === true || value === 'true'
    } else if (field.type === 'number') {
      const n = Number(value)
      clean[field.key] = Number.isFinite(n) ? n : value
    } else {
      clean[field.key] = value
    }
  }
  return clean
}
