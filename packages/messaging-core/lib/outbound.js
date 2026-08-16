/**
 * Outbound router: subscribes to durable `session/event` facts and pushes
 * them to the platform adapter owning each messaging chat.
 *
 * Streaming model (per session):
 *   - turn/start resets the buffer and starts the typing indicator;
 *   - assistant/chunk text deltas accumulate into the buffer; streaming
 *     platforms get throttled edit-message updates while the buffer stays
 *     under the platform's message cap (no truncation is ever sent — when the
 *     cap is hit, streaming preview stops and the final delivery chunks);
 *   - assistant/message (one per step) flushes immediately; if the provider
 *     emitted no chunks for that step the assembled text is appended;
 *   - turn/end finalizes: chunked delivery of the full text, then a short
 *     status line for aborted/error/blocked endings.
 */

import { renderForCapability } from './markdown.js'

const EDIT_THROTTLE_MS = 350
const TYPING_INTERVAL_MS = 4500

function messageText(message) {
  return (message && Array.isArray(message.content) ? message.content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function splitText(text, cap) {
  if (text.length <= cap) return [text]
  const parts = []
  let rest = text
  while (rest.length > cap) {
    let cut = rest.lastIndexOf('\n', cap)
    if (cut < cap / 2) cut = cap
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

export function createOutboundRouter(ctx, { adapters, sessionMap, logger }) {
  /** sessionId -> { turn, buffer, chunkedSteps, messageId, typingTimer, editTimer, editStopped } */
  const state = new Map()

  function chatInfoFor(sessionId) {
    const chatKey = sessionMap.chatKeyFor(sessionId)
    if (!chatKey) return undefined
    const platform = chatKey.split(':')[0]
    const adapter = adapters.get(platform)
    if (!adapter) return undefined
    const entry = sessionMap.entryFor(chatKey)
    return {
      adapter,
      target: { chatId: entry && entry.chatId ? entry.chatId : chatKey.split(':').slice(1).join(':'), threadId: entry && entry.threadId },
    }
  }

  function stateFor(sessionId) {
    let s = state.get(sessionId)
    if (!s) {
      s = { turn: 0, buffer: '', chunkedSteps: new Set(), messageId: null, typingTimer: null, editTimer: null, editStopped: false }
      state.set(sessionId, s)
    }
    return s
  }

  function clearEditTimer(s) {
    if (s.editTimer) {
      clearTimeout(s.editTimer)
      s.editTimer = null
    }
  }

  function stopTyping(sessionId, s) {
    if (s.typingTimer) {
      clearInterval(s.typingTimer)
      s.typingTimer = null
    }
    void sessionId
  }

  function startTyping(sessionId, info) {
    const s = stateFor(sessionId)
    if (s.typingTimer || !info.adapter.capabilities.typing) return
    info.adapter.sendTyping(info.target).catch(() => {})
    s.typingTimer = setInterval(() => {
      info.adapter.sendTyping(info.target).catch(() => {})
    }, TYPING_INTERVAL_MS)
  }

  /** Throttled streaming edit (never truncates; stops preview above the cap). */
  function scheduleEdit(sessionId, info, s) {
    if (!info.adapter.capabilities.streaming || s.editTimer || s.editStopped) return
    s.editTimer = setTimeout(() => {
      s.editTimer = null
      performEdit(sessionId, info, s).catch((error) => logger.warn(`streaming edit failed: ${error.message}`))
    }, EDIT_THROTTLE_MS)
  }

  async function performEdit(sessionId, info, s) {
    const cap = info.adapter.capabilities.maxMessageLength || 4000
    const raw = s.buffer.trim()
    if (!raw) return
    if (raw.length > cap) {
      // Never send truncated markup: stop the streaming preview, the final
      // delivery will chunk the full text.
      s.editStopped = true
      return
    }
    const text = renderForCapability(raw, info.adapter.capabilities)
    if (s.messageId === null) {
      const result = await info.adapter.send(info.target, text)
      s.messageId = result && result.messageId ? result.messageId : null
    } else {
      await info.adapter.editMessage(info.target, s.messageId, text)
    }
    void sessionId
  }

  async function sendChunked(info, raw) {
    const cap = info.adapter.capabilities.maxMessageLength || 4000
    const text = renderForCapability(raw, info.adapter.capabilities)
    const parts = splitText(text, cap)
    for (const part of parts) {
      await info.adapter.send(info.target, part)
    }
  }

  async function finalize(sessionId, info, s, reason) {
    stopTyping(sessionId, s)
    clearEditTimer(s)
    const raw = s.buffer.trim()
    if (raw) {
      const cap = info.adapter.capabilities.maxMessageLength || 4000
      const text = renderForCapability(raw, info.adapter.capabilities)
      const parts = splitText(text, cap)
      if (info.adapter.capabilities.streaming && s.messageId !== null) {
        // Replace the streamed preview with the exact first chunk, then send
        // any remainder as new messages.
        await info.adapter.editMessage(info.target, s.messageId, parts[0])
        for (const part of parts.slice(1)) {
          await info.adapter.send(info.target, part)
        }
      } else {
        for (const part of parts) {
          await info.adapter.send(info.target, part)
        }
      }
    }
    if (reason) {
      if (reason.kind === 'aborted') {
        await info.adapter.send(info.target, '⏹ 已中断')
      } else if (reason.kind === 'error') {
        const detail = reason.error && (reason.error.message || reason.error.code)
        await info.adapter.send(info.target, `⚠️ 本轮出错：${detail || '未知错误'}`)
      } else if (reason.kind === 'blocked') {
        await info.adapter.send(info.target, '⏸ 本轮被拒绝，未执行')
      }
    }
  }

  async function onSessionEvent(session, event) {
    const info = chatInfoFor(session.id)
    if (!info) return
    const s = stateFor(session.id)
    try {
      switch (event.type) {
        case 'turn/start': {
          s.turn = event.data.turn
          s.buffer = ''
          s.chunkedSteps = new Set()
          s.messageId = null
          s.editStopped = false
          clearEditTimer(s)
          startTyping(session.id, info)
          break
        }
        case 'assistant/chunk': {
          const chunk = event.data.chunk
          if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            s.buffer += chunk.text
            s.chunkedSteps.add(event.data.step)
            scheduleEdit(session.id, info, s)
          }
          break
        }
        case 'assistant/message': {
          if (!s.chunkedSteps.has(event.data.step)) {
            s.buffer += messageText(event.data.message)
          }
          clearEditTimer(s)
          if (info.adapter.capabilities.streaming && s.messageId === null && !s.editStopped) {
            await performEdit(session.id, info, s)
          }
          break
        }
        case 'turn/end': {
          await finalize(session.id, info, s, event.data.reason)
          break
        }
        default:
          break
      }
    } catch (error) {
      logger.error(`outbound routing failed for ${session.id}: ${error.stack || error.message}`)
    }
  }

  function dispose() {
    for (const s of state.values()) {
      clearEditTimer(s)
      stopTyping('', s)
    }
    state.clear()
  }

  return { onSessionEvent, dispose }
}
