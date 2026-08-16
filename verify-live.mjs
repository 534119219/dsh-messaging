#!/usr/bin/env node
/**
 * verify-live — check whether the running dsh web serves the current
 * messaging build (host endpoints + client bundle).
 *
 * Usage:  node verify-live.mjs
 *
 * Exit 0 = new build live; 1 = old build still running (needs restart).
 */
const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'

async function main() {
  const results = []

  // 1. /messaging/status must be JSON with our platforms.
  try {
    const res = await fetch(`${BASE}/messaging/status`, { headers: { accept: 'application/json' } })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    if (json && Array.isArray(json.platforms)) {
      const connected = json.platforms.filter((p) => p.connected).map((p) => p.id)
      results.push(`✅ /messaging/status: ${json.platforms.length} 平台注册，已连接: ${connected.join(', ') || '（无）'}`)
    } else {
      results.push(`❌ /messaging/status: 非预期响应（HTTP ${res.status}）——插件未加载？`)
    }
  } catch (e) {
    results.push(`❌ /messaging/status: ${e.message}——dsh web 未运行？`)
  }

  // 2. /messaging/config must be JSON (new build) vs HTML (old build).
  try {
    const res = await fetch(`${BASE}/messaging/config`, { headers: { accept: 'application/json' } })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* html */ }
    if (json && json.platforms) {
      const ids = Object.keys(json.platforms)
      results.push(`✅ /messaging/config: ${ids.length} 平台目录（新版构建）`)
    } else {
      results.push(`❌ /messaging/config: 返回 HTML——旧构建仍在运行，需要重启 dsh web`)
    }
  } catch (e) {
    results.push(`❌ /messaging/config: ${e.message}`)
  }

  // 3. client bundle for messaging-core must be served.
  try {
    const html = await (await fetch(BASE)).text()
    const m = html.match(/\/plugins\/messaging-core[^"']*/)
    if (m) {
      const bundleRes = await fetch(`${BASE}${m[0]}`)
      results.push(`✅ client bundle: ${m[0]} (HTTP ${bundleRes.status})`)
    } else {
      results.push(`❌ client bundle: 启动图里没有 messaging-core 条目（旧构建）`)
    }
  } catch (e) {
    results.push(`❌ client bundle: ${e.message}`)
  }

  for (const line of results) console.log(line)
  const ok = results.every((r) => r.startsWith('✅'))
  console.log(ok ? '\n结果：新版已生效 ✅' : '\n结果：旧构建仍在运行，请手动重启 dsh web')
  // Windows + undici teardown can abort with a libuv assertion on natural
  // exit; settle the exit code explicitly after a tick to avoid it.
  setTimeout(() => process.exit(ok ? 0 : 1), 10)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
