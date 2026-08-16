/**
 * QR scan-to-authorize flows (hermes-style onboarding).
 *
 * Supported platforms:
 *   - qq:      q.qq.com openclaw bind task — scan with QQ to bind a bot app;
 *              on success the bot's appId + clientSecret (AES-256-GCM,
 *              decrypted locally) are saved into messaging-qq.
 *   - weixin:  WeChat iLink QR login — scan with WeChat; on success the
 *              accountId/token/baseUrl are saved into messaging-weixin.
 *   - whatsapp: Baileys device pairing — the adapter emits a pairing QR;
 *              this manager surfaces it and watches for the connection.
 *
 * The client dialog drives the flow through two host endpoints:
 *   POST /messaging/qr/start  { platform } -> { taskId, qrImage, qrData }
 *   GET  /messaging/qr/status?task=<id>   -> { status, message, qrImage? }
 */
import { createDecipheriv, randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

const QQ_PORTAL = 'https://q.qq.com'
const QQ_CREATE_PATH = '/lite/create_bind_task'
const QQ_POLL_PATH = '/lite/poll_bind_result'
const QQ_QR_TEMPLATE = 'https://q.qq.com/qqbot/openclaw/connect.html?task_id={id}&_wv=2&source=dsh'

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_BOT_TYPE = '3'

function qqHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'dsh-messaging/0.1',
  }
}

async function qqJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: qqHeaders(), body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (data.retcode !== 0) throw new Error(data.msg || `qq qr api failed (HTTP ${res.status})`)
  return data.data || {}
}

/** AES-256-GCM decrypt of the bot client_secret (IV 12 + ct + tag 16). */
function qqDecryptSecret(encryptedBase64, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const raw = Buffer.from(encryptedBase64, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ct = raw.subarray(12, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** Render one QR payload to a PNG data URL for the dialog <img>. */
async function renderQr(data) {
  try {
    return await QRCode.toDataURL(String(data), { margin: 1, width: 300, errorCorrectionLevel: 'M' })
  } catch {
    return ''
  }
}

export function createQrManager(ctx, { logger, getAdapter }) {
  /** taskId -> task state */
  const tasks = new Map()

  function saveConfig(id, patch) {
    try {
      return ctx.settings.update(settingsNamespace(`messaging-${id}`), patch)
    } catch (error) {
      logger.warn(`qr save failed for ${id}: ${error.message}`)
      throw error
    }
  }

  function task(id, state) {
    const t = { id, platform: state.platform, status: 'pending', message: '', qrImage: '', qrData: '', state, createdAt: Date.now() }
    tasks.set(id, t)
    return t
  }

  function finish(t, status, message, extra) {
    t.status = status
    t.message = message
    if (extra) Object.assign(t, extra)
  }

  // ------------------------------------------------------------ providers

  const providers = {
    /** qq — q.qq.com scan-to-configure bind task. */
    async qqStart() {
      const key = Buffer.from(randomBytes(32)).toString('base64')
      const d = await qqJson(`${QQ_PORTAL}${QQ_CREATE_PATH}`, { key })
      if (!d.task_id) throw new Error('qq bind task response missing task_id')
      const taskId = String(d.task_id)
      const qrData = QQ_QR_TEMPLATE.replace('{id}', encodeURIComponent(taskId))
      return { taskId, qrData, secret: { key, taskId } }
    },
    async qqPoll(secret) {
      const d = await qqJson(`${QQ_PORTAL}${QQ_POLL_PATH}`, { task_id: secret.taskId })
      const status = Number(d.status || 0)
      if (status === 2) {
        const appId = String(d.bot_appid || '')
        const clientSecret = qqDecryptSecret(String(d.bot_encrypt_secret || ''), secret.key)
        const userOpenid = String(d.user_openid || '')
        if (!appId || !clientSecret) throw new Error('qq bind completed but credentials are incomplete')
        const patch = { appId, clientSecret }
        if (userOpenid) patch.allowedUsers = [userOpenid]
        await saveConfig('qq', patch)
        return { status: 'done', message: `✅ 授权成功（AppID ${appId}）`, extra: { userOpenid } }
      }
      if (status === 3) return { status: 'expired', message: '二维码已过期，请重新发起。' }
      return { status: 'pending', message: '等待扫码…' }
    },

    /** weixin — WeChat iLink QR login (poll handles redirect hosts). */
    async weixinStart() {
      const res = await fetch(`${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`, {
        headers: { Accept: 'application/json' },
      })
      const d = await res.json().catch(() => ({}))
      const qrValue = String(d.qrcode || '')
      const qrUrl = String(d.qrcode_img_content || '')
      if (!qrValue) throw new Error('weixin qr response missing qrcode')
      return { taskId: `wx-${qrValue.slice(0, 12)}`, qrData: qrUrl || qrValue, secret: { qrValue, baseUrl: ILINK_BASE_URL } }
    },
    async weixinPoll(secret) {
      const { qrValue } = secret
      let baseUrl = secret.baseUrl
      const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrValue)}`
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      const d = await res.json().catch(() => ({}))
      const status = String(d.status || 'wait')
      if (status === 'confirmed') {
        const accountId = String(d.ilink_bot_id || '')
        const token = String(d.bot_token || '')
        const confirmedBase = String(d.baseurl || ILINK_BASE_URL).replace(/\/+$/, '')
        const userId = String(d.ilink_user_id || '')
        if (!accountId || !token) throw new Error('weixin qr confirmed but credentials are incomplete')
        await saveConfig('weixin', { accountId, token, baseUrl: confirmedBase, userId })
        return { status: 'done', message: '✅ 微信授权成功', extra: { userId } }
      }
      if (status === 'expired') return { status: 'expired', message: '二维码已过期，请重新发起。' }
      if (status === 'scaned_but_redirect' && d.redirect_host) {
        secret.baseUrl = `https://${String(d.redirect_host)}`
        return { status: 'pending', message: '已扫码，请在微信中确认…' }
      }
      if (status === 'scaned') return { status: 'pending', message: '已扫码，请在微信中确认…' }
      return { status: 'pending', message: '等待扫码…' }
    },

    /** whatsapp — surface the Baileys pairing QR from the adapter. */
    async whatsappStart() {
      const adapter = getAdapter('whatsapp')
      if (!adapter) throw new Error('whatsapp adapter unavailable')
      if (adapter.connected) throw new Error('WhatsApp 已连接，无需配对。')
      if (adapter.qrInfo) {
        const info = adapter.qrInfo()
        if (info && info.qr) {
          return { taskId: `wa-${Date.now()}`, qrData: info.qr, secret: {} }
        }
      }
      // Ask the adapter to start connecting (pairing mode) and wait for a QR.
      if (typeof adapter.startPairing === 'function') {
        adapter.startPairing().catch((error) => logger.warn(`whatsapp pairing start failed: ${error.message}`))
      }
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (adapter.connected) throw new Error('WhatsApp 已连接，无需配对。')
        const info = adapter.qrInfo ? adapter.qrInfo() : null
        if (info && info.qr) {
          return { taskId: `wa-${Date.now()}`, qrData: info.qr, secret: {} }
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('未产生配对二维码：请确认已在弹窗中勾选"启用"，并清除旧的配对数据。')
    },
    async whatsappPoll() {
      const adapter = getAdapter('whatsapp')
      if (adapter && adapter.connected) return { status: 'done', message: '✅ WhatsApp 配对成功' }
      const info = adapter && adapter.qrInfo ? adapter.qrInfo() : null
      return info && info.qr
        ? { status: 'pending', message: '用 WhatsApp → 已链接的设备 扫码', extra: { qrData: info.qr } }
        : { status: 'pending', message: '等待扫码…' }
    },
  }

  // ------------------------------------------------------------- manager

  /** Start a QR flow; returns the client payload. */
  async function start(platform) {
    const provider = providers[platform]
    if (!provider) throw new Error(`platform ${platform} does not support QR authorization`)
    const started = await provider[`${platform}Start`]()
    const t = task(started.taskId, { platform, secret: started.secret })
    t.qrData = started.qrData
    t.qrImage = await renderQr(started.qrData)
    return { taskId: t.id, platform, qrImage: t.qrImage, qrData: t.qrData, status: 'pending' }
  }

  /** Poll one task; returns the client payload. */
  async function status(taskId) {
    const t = tasks.get(taskId)
    if (!t) return { ok: false, error: 'task not found' }
    if (t.status === 'done' || t.status === 'expired') return payload(t)
    try {
      const provider = providers[t.platform]
      const result = await provider[`${t.platform}Poll`](t.state.secret)
      t.status = result.status
      t.message = result.message
      if (result.extra && result.extra.qrData) {
        t.qrData = result.extra.qrData
        t.qrImage = await renderQr(result.extra.qrData)
      }
      if (result.status === 'done') t.doneAt = Date.now()
    } catch (error) {
      t.status = 'error'
      t.message = `⚠️ ${error.message}`
    }
    return payload(t)
  }

  function payload(t) {
    return {
      ok: true,
      taskId: t.id,
      platform: t.platform,
      status: t.status,
      message: t.message,
      qrImage: t.qrImage,
      qrData: t.qrData,
    }
  }

  // Periodic cleanup of stale tasks (expired/older than 30 min).
  setInterval(() => {
    const now = Date.now()
    for (const [id, t] of tasks) {
      if (t.status === 'done' || t.status === 'expired' || t.status === 'error' || now - t.createdAt > 30 * 60 * 1000) {
        tasks.delete(id)
      }
    }
  }, 5 * 60 * 1000).unref()

  return { start, status }
}
