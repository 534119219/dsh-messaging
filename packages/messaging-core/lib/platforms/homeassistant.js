/**
 * platform-homeassistant — Home Assistant messaging adapter for DSH.
 *
 * Connects to the HA WebSocket API (auto-reconnecting): entity state-change
 * events (detected by diffing subscribeEntities snapshots) are forwarded to
 * the agent as inbound messages; agent replies are delivered as HA
 * persistent notifications. Authorization is the long-lived access token
 * itself, so the shared core allowlist is bypassed by design.
 *
 * Configuration (settings namespace `messaging-homeassistant`):
 *   hassUrl:  e.g. http://homeassistant.local:8123 (env: HASS_URL)
 *   token:    long-lived access token (env: HASS_TOKEN)
 *   entities: entity ids to watch; empty = all state changes
 *   homeChannel: reserved
 */
import z from 'schemastery'
import { callService, createConnection, createLongLivedTokenAuth, subscribeEntities } from 'home-assistant-js-websocket'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'


export function register(ctx) {
  const logger = ctx.logger('hass')

  let cfgScope
  try {
    cfgScope = ctx.settings.register(settingsNamespace('messaging-homeassistant'), z.object({
      hassUrl: z.string().default(''),
      token: z.string().role('secret').default(''),
      entities: z.array(z.string()).default([]),
      homeChannel: z.string().default(''),
    }))
  } catch (error) {
    logger.warn(`settings namespace 'messaging-homeassistant' unavailable: ${error.message}`)
  }

  function resolveConfig() {
    const resolved = cfgScope ? cfgScope.get() : {}
    return {
      ...resolved,
      hassUrl: (resolved.hassUrl && resolved.hassUrl.trim()) || process.env.HASS_URL || 'http://homeassistant.local:8123',
      token: (resolved.token && resolved.token.trim()) || process.env.HASS_TOKEN || '',
      // The long-lived token IS the auth gate for HASS.
      allowAll: true,
    }
  }

  let connection = null
  let unsubscribe = null
  /** Last seen entity snapshot, diffed to detect state changes. */
  let lastEntities = null

  const adapter = {
    id: 'homeassistant',
    connected: false,
    capabilities: {
      streaming: false,
      typing: false,
      buttons: false,
      media: [],
      markdown: 'plain',
      maxMessageLength: 5000,
    },
    resolveConfig,

    async connect() {
      if (connection) return
      const cfg = resolveConfig()
      if (!cfg.token) {
        logger.warn('homeassistant: 未配置 token（settings messaging-homeassistant.token 或 HASS_TOKEN）')
        return
      }
      const auth = createLongLivedTokenAuth(cfg.hassUrl, cfg.token)
      const conn = await createConnection({ auth })
      connection = conn
      unsubscribe = await subscribeEntities(conn, (entities) => {
        handleSnapshot(entities).catch((error) => logger.error(`hass event failed: ${error.stack || error.message}`))
      })
      adapter.connected = true
      logger.info(`homeassistant connected to ${cfg.hassUrl}`)
    },

    async disconnect() {
      const u = unsubscribe
      unsubscribe = null
      connection = null
      adapter.connected = false
      if (u) {
        try {
          u()
        } catch { /* ignore */ }
      }
    },

    async send(target, text) {
      if (!connection) throw new Error('homeassistant: not connected')
      await callService(connection, 'persistent_notification', 'create', { message: text, title: 'DSH Agent' })
      return {}
    },

    async sendTyping() { /* HASS has no typing */ },

    async sendMedia() {
      throw new Error('homeassistant: media unsupported')
    },

    async getChatInfo() {
      return { name: 'Home Assistant', type: 'hass', chatId: 'events' }
    },
  }

  const unregister = ctx.messaging.registerAdapter(adapter)
  ctx.on('dispose', () => {
    unregister()
    adapter.disconnect().catch(() => {})
  })

  const initial = resolveConfig()
  if (initial.token) {
    adapter.connect().catch((error) => logger.error(`homeassistant connect failed: ${error.stack || error.message}`))
  } else {
    logger.warn('homeassistant: 未配置 token，等待配置（settings messaging-homeassistant.token）')
  }
  if (cfgScope && typeof cfgScope.watch === 'function') {
    cfgScope.watch((next) => {
      if (next.token && !connection) {
        adapter.connect().catch((error) => logger.error(`homeassistant connect failed: ${error.stack || error.message}`))
      }
    })
  }

  /** Diff a fresh entities snapshot against the previous one and emit changes. */
  async function handleSnapshot(entities) {
    const cfg = resolveConfig()
    const prev = lastEntities
    lastEntities = entities
    if (!prev) return // first snapshot is the baseline, not a change
    const watched = cfg.entities && cfg.entities.length > 0 ? new Set(cfg.entities) : null
    for (const [entityId, entity] of Object.entries(entities)) {
      if (watched && !watched.has(entityId)) continue
      const oldState = prev[entityId] ? prev[entityId].state : null
      const newState = entity ? entity.state : null
      if (oldState === newState) continue
      const text = `${entityId}: ${oldState === null ? '∅' : oldState} → ${newState === null ? '∅' : newState}`
      await ctx.messaging.handleInbound('homeassistant', {
        platform: 'homeassistant',
        chatKey: 'hass:events',
        chatId: 'events',
        userId: 'hass',
        text,
        raw: { entity_id: entityId, old_state: oldState, new_state: newState },
      })
    }
  }
}
