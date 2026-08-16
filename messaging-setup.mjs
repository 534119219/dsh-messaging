#!/usr/bin/env node
/**
 * messaging-setup — self-service configuration wizard for DSH messaging.
 *
 * Usage:
 *   node messaging-setup.mjs                # interactive: pick a platform
 *   node messaging-setup.mjs telegram --token <token> --user-id <id>
 *   node messaging-setup.mjs list           # list platform ids
 *
 * Writes the `messaging-<platform>` section of $DSH_HOME/settings.yaml,
 * preserving every other section. Telegram tokens are validated against the
 * Bot API (getMe). Other platforms are written as-is; check the log after
 * restarting dsh web for connection results. A dsh web restart is required
 * for newly configured platforms (or wait — adapters watch settings).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { PLATFORM_CATALOG } from './packages/messaging-core/lib/config.js'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const settingsFile = join(home, 'settings.yaml')
const require = createRequire(join(home, 'profiles', 'web', 'package.json'))
const yaml = require('js-yaml')

/** Shared platform catalog (single source of truth with the web UI). */
const PLATFORMS = PLATFORM_CATALOG

/** Save-time validators keyed by platform id (telegram: live getMe check). */
const VALIDATORS = {
  async telegram(section) {
    if (!section.token) return null
    const res = await fetch(`https://api.telegram.org/bot${section.token}/getMe`)
    const body = await res.json()
    if (!body.ok) return `token 无效: ${body.description || 'unknown'}`
    return `✓ 已连接 @${body.result.username}`
  },
}


function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve))
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  // Legacy telegram non-interactive mode: messaging-setup.mjs --token <t> --user-id <id> [--allow-all]
  const legacyToken = flag('--token')
  const legacyUserId = flag('--user-id')
  const legacyAllowAll = args.includes('--allow-all')
  let platformId = args[0]
  if (legacyToken !== undefined || legacyUserId !== undefined || legacyAllowAll) {
    platformId = 'telegram'
  }

  if (platformId === 'list' || platformId === '--list') {
    for (const [id, p] of Object.entries(PLATFORMS)) console.log(`${id.padEnd(16)} ${p.label}`)
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    let id = platformId
    if (!id || !PLATFORMS[id]) {
      console.log('=== DSH messaging 配置向导 ===\n可用平台：')
      const ids = Object.keys(PLATFORMS)
      for (let i = 0; i < ids.length; i += 1) console.log(`  ${String(i + 1).padStart(2)}. ${ids[i]}  — ${PLATFORMS[ids[i]].label}`)
      const pick = (await ask(rl, '\n输入平台编号或 id: ')).trim().toLowerCase()
      if (/^\d+$/.test(pick)) id = ids[Number(pick) - 1]
      else id = pick
    }
    const platform = PLATFORMS[id]
    if (!platform) {
      console.error(`未知平台: ${id}（node messaging-setup.mjs list 查看全部）`)
      process.exitCode = 1
      return
    }

    console.log(`\n=== 配置 ${platform.label} ===`)
    const doc = existsSync(settingsFile) ? (yaml.load(readFileSync(settingsFile, 'utf8')) || {}) : {}
    const current = doc[`messaging-${id}`] || {}
    const legacyPrefill = {}
    if (id === 'telegram' && legacyToken !== undefined) legacyPrefill.token = legacyToken
    if (id === 'telegram' && legacyUserId !== undefined) legacyPrefill.allowedUsers = legacyUserId.split(',').map((s) => s.trim()).filter(Boolean)
    if (id === 'telegram' && legacyAllowAll) legacyPrefill.allowAll = true

    const section = { ...current, ...legacyPrefill }
    for (const field of platform.fields) {
      const existing = current[field.key]
      const hint = existing !== undefined ? `（当前: ${formatValue(existing)}）` : ''
      let input = ''
      if (field.type === 'bool') {
        const def = existing !== undefined ? existing : field.default
        input = (await ask(rl, `${field.label} [true/false]${hint}（回车=${def ? 'true' : 'false'}）: `)).trim()
        section[field.key] = input ? input === 'true' : Boolean(def)
      } else if (field.type === 'number') {
        input = (await ask(rl, `${field.label}${hint}（回车=${existing ?? field.default}）: `)).trim()
        section[field.key] = input ? Number(input) : (existing ?? field.default)
      } else if (field.type === 'list') {
        input = (await ask(rl, `${field.label}${hint}: `)).trim()
        section[field.key] = input ? input.split(',').map((s) => s.trim()).filter(Boolean) : (existing ?? [])
      } else if (field.type === 'json') {
        input = (await ask(rl, `${field.label}${hint}: `)).trim()
        if (input) {
          try { section[field.key] = JSON.parse(input) } catch { console.error('JSON 解析失败，保留原值'); }
        } else if (existing === undefined) section[field.key] = field.default ?? []
      } else {
        input = (await ask(rl, `${field.label}${field.secret ? '（输入不回显风险提示：本向导不隐藏输入）' : ''}${hint}: `)).trim()
        if (input) section[field.key] = input
        else if (existing === undefined && field.default !== undefined) section[field.key] = field.default
      }
    }

    for (const field of platform.fields) {
      if (field.required && (section[field.key] === undefined || section[field.key] === '')) {
        console.error(`缺少必填项：${field.label}`)
        process.exitCode = 1
        return
      }
    }

    doc[`messaging-${id}`] = section
    writeFileSync(settingsFile, yaml.dump(doc, { lineWidth: 120 }), 'utf8')
    console.log(`✓ 已写入 ${settingsFile} 的 messaging-${id} 节`)
    if (platform.note) console.log(`提示：${platform.note}`)
    const validator = VALIDATORS[id]
    if (typeof validator === 'function') {
      try {
        const result = await validator(section)
        if (result) console.log(result)
      } catch (error) {
        console.log(`校验失败：${error.message}`)
      }
    }
    console.log('下一步：手动重启 dsh web 生效（或等待 settings watch 自动重连）。')
  } finally {
    rl.close()
  }
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join(',') || '(空)'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
