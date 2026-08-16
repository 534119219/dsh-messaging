#!/usr/bin/env node
/**
 * weixin-pair — QR-login pairing wizard for the DSH Weixin (iLink) adapter.
 *
 * Usage:  node weixin-pair.mjs
 *
 * Talks to the iLink Bot API directly (same protocol as hermes-agent):
 *   1. GET  ilink/bot/get_bot_qrcode?bot_type=3  → QR content
 *   2. print the QR (terminal ASCII) + scannable URL
 *   3. poll ilink/bot/get_qrcode_status?qrcode=… until confirmed/expired
 *   4. write messaging-weixin.accountId/token/baseUrl into $DSH_HOME/settings.yaml
 *
 * After pairing, restart dsh web (or just wait — the adapter watches settings).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const settingsFile = join(home, 'settings.yaml')
const require = createRequire(join(home, 'profiles', 'web', 'package.json'))
const yaml = require('js-yaml')
const QRCode = require('qrcode')

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode'
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status'
const BOT_TYPE = '3'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function apiGet(baseUrl, endpoint, timeoutMs = 35000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}/${endpoint}`, {
      headers: {
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String((2 << 16) | (2 << 8) | 0),
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`iLink GET ${endpoint} HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log('=== DSH 微信（iLink）配对向导 ===')
  console.log('注意：非官方协议，有账号风险（与 hermes 一致）')

  let baseUrl = ILINK_BASE_URL
  let qrValue = ''
  let refreshes = 0

  async function fetchQr() {
    const resp = await apiGet(baseUrl, `${EP_GET_BOT_QR}?bot_type=${BOT_TYPE}`)
    qrValue = String(resp.qrcode || '')
    const qrUrl = String(resp.qrcode_img_content || '')
    if (!qrValue) throw new Error('QR 响应缺少 qrcode 字段')
    const scanData = qrUrl || qrValue
    console.log('\n请用微信扫描以下二维码（或打开链接）：')
    if (qrUrl) console.log(qrUrl)
    try {
      console.log(await QRCode.toString(scanData, { type: 'terminal', small: true }))
    } catch {
      console.log('（终端二维码渲染失败，请直接打开上面的链接）')
    }
  }

  await fetchQr()
  const deadline = Date.now() + 120 * 1000
  while (Date.now() < deadline) {
    try {
      const statusResp = await apiGet(baseUrl, `${EP_GET_QR_STATUS}?qrcode=${qrValue}`)
      const status = String(statusResp.status || 'wait')
      if (status === 'wait') {
        process.stdout.write('.')
      } else if (status === 'scaned') {
        console.log('\n已扫码，请在微信里确认...')
      } else if (status === 'scaned_but_redirect') {
        const redirectHost = String(statusResp.redirect_host || '')
        if (redirectHost) baseUrl = `https://${redirectHost}`
      } else if (status === 'confirmed') {
        const accountId = String(statusResp.ilink_bot_id || '')
        const token = String(statusResp.bot_token || '')
        const confirmedBase = String(statusResp.baseurl || ILINK_BASE_URL).replace(/\/+$/, '')
        if (!accountId || !token) throw new Error('确认响应缺少凭据')
        const doc = existsSync(settingsFile) ? (yaml.load(readFileSync(settingsFile, 'utf8')) || {}) : {}
        doc['messaging-weixin'] = {
          ...(doc['messaging-weixin'] || {}),
          accountId,
          token,
          baseUrl: confirmedBase,
        }
        writeFileSync(settingsFile, yaml.dump(doc, { lineWidth: 120 }), 'utf8')
        console.log(`\n✓ 微信连接成功，account_id=${accountId.slice(0, 6)}... 已写入 ${settingsFile}`)
        console.log('重启 dsh web 后生效（或等待 settings watch 自动连接）。')
        return
      } else if (status === 'expired') {
        refreshes += 1
        if (refreshes > 3) {
          console.log('\n二维码多次过期，请重新运行。')
          process.exitCode = 1
          return
        }
        console.log(`\n二维码已过期，刷新中... (${refreshes}/3)`)
        await fetchQr()
      }
    } catch (error) {
      if (error && error.name === 'AbortError') continue
      console.error(`\n轮询出错: ${error.message}`)
    }
    await sleep(1000)
  }
  console.log('\n微信登录超时。')
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
