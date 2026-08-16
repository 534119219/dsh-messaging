/**
 * Minimal markdown -> platform-flavored rendering for messaging adapters.
 *
 * M0 supports one flavor: 'html' (Telegram parse_mode=HTML). Code spans are
 * protected before bold/italic/link transforms so markup inside code stays
 * literal.
 */

const PROTECT = '\u0000'

export function markdownToHtml(text) {
  if (!text) return ''
  let out = escapeHtml(text)
  const protectedSpans = []
  // Protect fenced code blocks and inline code (already escaped).
  out = out.replace(/```[^\n]*\n[\s\S]*?```|`[^`\n]+`/g, (span) => {
    const index = protectedSpans.push(span) - 1
    return `${PROTECT}${index}${PROTECT}`
  })
  // Links: [label](https://...)
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
  // Bold then italic (bold first so ** is not half-consumed).
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  out = out.replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
  // Restore protected code spans.
  out = out.replace(new RegExp(`${PROTECT}(\\d+)${PROTECT}`, 'g'), (_, i) => {
    const span = protectedSpans[Number(i)]
    if (span.startsWith('```')) {
      return `<pre>${span.replace(/^```[^\n]*\n/, '').replace(/```$/, '').trim()}</pre>`
    }
    return `<code>${span.slice(1, -1)}</code>`
  })
  return out
}

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Render assistant text for one adapter's capability set:
 *   - 'html'   -> markdown converted to HTML (Telegram parse_mode=HTML)
 *   - 'plain'  -> markdown passed through verbatim (Discord/Slack/IRC render
 *                 markdown natively)
 */
export function renderForCapability(text, capabilities) {
  if (!capabilities || capabilities.markdown !== 'html') return text
  return markdownToHtml(text)
}
