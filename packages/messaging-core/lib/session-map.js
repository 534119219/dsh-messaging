/**
 * Chat-to-session mapping for the messaging gateway.
 *
 * A chat (platform + chat id) maps to a DSH session id of the shape
 * `msg-<platform>-<hash>` (deterministic from the chat key) with `-vN`
 * appended each time the user runs `/new` (fresh conversation). The mapping
 * plus chat metadata is persisted as JSONL under $DSH_HOME/messaging/ so the
 * outbound router can reverse session id -> chat and the status tool can list
 * chats.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function createSessionMap({ logger }) {
  const file = join(dshHome(), 'messaging', 'session-map.jsonl')
  /** chatKey -> entry */
  const byChat = new Map()
  /** sessionId -> chatKey */
  const bySession = new Map()
  let loaded = false

  function load() {
    if (loaded) return
    loaded = true
    try {
      if (!existsSync(file)) return
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry && entry.chatKey && entry.sessionId) {
            // Backfill history for entries written before /resume existed.
            if (!Array.isArray(entry.history) || entry.history.length === 0) {
              entry.history = [{ sessionId: entry.sessionId, generation: entry.generation || 0, updatedAt: entry.updatedAt || 0 }]
            }
            byChat.set(entry.chatKey, entry)
            bySession.set(entry.sessionId, entry.chatKey)
          }
        } catch { /* skip malformed line */ }
      }
    } catch (error) {
      logger.warn(`session map load failed (${file}): ${error.message}`)
    }
  }

  function persist() {
    try {
      const dir = join(file, '..')
      mkdirSync(dir, { recursive: true })
      const lines = [...byChat.values()].map((entry) => JSON.stringify(entry))
      writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '')
    } catch (error) {
      logger.warn(`session map save failed (${file}): ${error.message}`)
    }
  }

  function hashChatKey(chatKey) {
    return createHash('sha1').update(chatKey).digest('hex').slice(0, 12)
  }

  function defaultId(chatKey, generation) {
    const base = `msg-${chatKey.split(':')[0]}-${hashChatKey(chatKey)}`
    return generation ? `${base}-v${generation}` : base
  }

  /** Deterministic session id for a chat (no entry required). */
  function sessionIdFor(chatKey) {
    load()
    const entry = byChat.get(chatKey)
    return entry ? entry.sessionId : defaultId(chatKey, 0)
  }

  /** Record/refresh chat metadata and return the entry. */
  function touch(chatKey, meta) {
    load()
    const prev = byChat.get(chatKey)
    const entry = {
      chatKey,
      sessionId: prev ? prev.sessionId : defaultId(chatKey, prev ? prev.generation : 0),
      generation: prev ? prev.generation : 0,
      history: prev && Array.isArray(prev.history) && prev.history.length ? prev.history : [],
      ...meta,
      updatedAt: Date.now(),
    }
    if (entry.history.length === 0) {
      entry.history.push({ sessionId: entry.sessionId, generation: entry.generation, updatedAt: entry.updatedAt })
    }
    byChat.set(chatKey, entry)
    bySession.set(entry.sessionId, chatKey)
    persist()
    return entry
  }

  /** Start a fresh conversation: bump generation past every historical one. */
  function reset(chatKey) {
    load()
    const prev = byChat.get(chatKey)
    if (prev) bySession.delete(prev.sessionId)
    const history = prev && Array.isArray(prev.history) && prev.history.length ? prev.history : []
    const generation = history.reduce((max, h) => Math.max(max, Number(h.generation) || 0), 0) + 1
    const entry = {
      ...(prev ? { platform: prev.platform, chatId: prev.chatId, threadId: prev.threadId, userId: prev.userId, userName: prev.userName } : {}),
      chatKey,
      sessionId: defaultId(chatKey, generation),
      generation,
      history,
      updatedAt: Date.now(),
    }
    entry.history.push({ sessionId: entry.sessionId, generation, updatedAt: entry.updatedAt })
    if (entry.history.length > 20) entry.history = entry.history.slice(-20)
    byChat.set(chatKey, entry)
    bySession.set(entry.sessionId, chatKey)
    persist()
    return entry
  }

  /** Per-chat session history (oldest first). */
  function historyFor(chatKey) {
    load()
    const entry = byChat.get(chatKey)
    return entry && Array.isArray(entry.history) ? entry.history : []
  }

  /** Switch the chat's active session to a past one (validated against history). */
  function resume(chatKey, sessionId) {
    load()
    const entry = byChat.get(chatKey)
    const history = entry && Array.isArray(entry.history) ? entry.history : []
    if (!history.some((h) => h.sessionId === sessionId)) return false
    if (entry && entry.sessionId === sessionId) return true
    if (entry) bySession.delete(entry.sessionId)
    const next = {
      ...(entry || { chatKey }),
      sessionId,
      history,
      updatedAt: Date.now(),
    }
    byChat.set(chatKey, next)
    bySession.set(sessionId, chatKey)
    persist()
    return true
  }

  /** Cache a title on one history item (best-effort; /resume lists titles). */
  function setHistoryTitle(chatKey, sessionId, title) {
    load()
    const entry = byChat.get(chatKey)
    if (!entry || !Array.isArray(entry.history)) return
    let changed = false
    for (const h of entry.history) {
      if (h.sessionId === sessionId && h.title !== title) {
        h.title = title
        changed = true
      }
    }
    if (changed) persist()
  }

  function chatKeyFor(sessionId) {
    load()
    return bySession.get(sessionId)
  }

  function entryFor(chatKey) {
    load()
    return byChat.get(chatKey)
  }

  function entries() {
    load()
    return [...byChat.values()]
  }

  return { sessionIdFor, touch, reset, resume, setHistoryTitle, historyFor, chatKeyFor, entryFor, entries }
}
