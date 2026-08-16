/**
 * Shared webhook HTTP listener for messaging platform adapters.
 *
 * One small node:http server on a dedicated port (default 127.0.0.1:8765)
 * hosts per-platform routes (LINE, Twilio, WhatsApp Cloud, ...). Adapters
 * register their path and handler; the server starts lazily on the first
 * registration. Raw request bodies are captured so adapters can verify
 * platform signatures (HMAC etc.). Public exposure is the user's reverse
 * proxy / tunnel, documented per platform.
 */
import { createServer } from 'node:http'

const MAX_BODY_BYTES = 10 * 1024 * 1024

export function createWebhookServer(ctx, { logger, port = 8765, host = '127.0.0.1' }) {
  /** path -> async ({ req, res, url, raw, method, headers }) => void */
  const routes = new Map()
  let server = null

  function register(path, handler) {
    if (routes.has(path)) throw new Error(`webhook path already registered: ${path}`)
    routes.set(path, handler)
    ensureStarted()
    return () => {
      routes.delete(path)
    }
  }

  function ensureStarted() {
    if (server) return
    server = createServer((req, res) => {
      handle(req, res).catch((error) => {
        logger.error(`webhook ${req.url} failed: ${error.stack || error.message}`)
        if (!res.headersSent) {
          res.writeHead(500)
          res.end('internal error')
        }
      })
    })
    server.listen(port, host, () => {
      logger.info(`webhook listener on http://${host}:${port}`)
    })
    server.on('error', (error) => {
      logger.error(`webhook listener error: ${error.message}`)
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413)
        res.end()
        return
      }
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks)
    await handler({ req, res, url, raw, method: req.method || 'GET', headers: req.headers })
  }

  function stop() {
    if (server) {
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        server.close()
      } catch { /* ignore */ }
      server = null
    }
  }

  return { register, stop }
}
