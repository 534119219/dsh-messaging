/**
 * Per-platform workspaces for messaging sessions.
 *
 * Each platform gets its own workspace directory under
 * `$DSH_HOME/messaging/workspace/<platform>`, registered with the host
 * workspace registry (dsh-workspace) so the sidebar groups sessions by
 * platform instead of leaving them Ungrouped. Agent sessions are created
 * with `meta.cwd` pointing at the platform directory, which the registry
 * indexes as the workspace path.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function workspaceRoot() {
  return join(dshHome(), 'messaging', 'workspace')
}

export function workspaceDirFor(platform) {
  return join(workspaceRoot(), String(platform))
}

/** Create the platform workspace directory (idempotent) and return its path. */
export function ensureWorkspaceDir(platform) {
  const dir = workspaceDirFor(platform)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Resolve the host workspace registry. Plain property access only sees
 * ancestor-scope services; `dsh-workspace` mounts as a sibling entry, so
 * fall back to `ctx.get('workspaceRegistry')` (the reflect store).
 */
export function resolveWorkspaceRegistry(ctx) {
  try {
    if (ctx && ctx.workspaceRegistry) return ctx.workspaceRegistry
  } catch { /* fall through */ }
  try {
    const found = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
    if (found) return found
  } catch { /* fall through */ }
  return null
}

/** Register (or resolve) the per-platform workspace record; entity or null. */
export async function ensurePlatformWorkspace(ctx, platform, title) {
  const registry = resolveWorkspaceRegistry(ctx)
  if (!registry) return null
  const dir = workspaceDirFor(platform)
  try {
    let entity = null
    try {
      const created = await registry.create(dir, title)
      entity = created || null
    } catch { /* record may already exist; resolve below is authoritative */ }
    if (!entity) {
      try {
        entity = await registry.resolveByPath(dir)
      } catch { /* ignore */ }
    }
    return entity
  } catch {
    return null
  }
}

/** Best-effort attach of a session id to its platform workspace. */
export async function attachSessionToPlatformWorkspace(ctx, platform, sessionId, title) {
  const registry = resolveWorkspaceRegistry(ctx)
  if (!registry) return
  const ws = await ensurePlatformWorkspace(ctx, platform, title)
  if (ws && typeof ws.attachSession === 'function') {
    await ws.attachSession(sessionId)
  } else {
    const wsId = ws && (ws.id || ws.workspaceId)
    if (wsId && registry.get) {
      const entity = registry.get(wsId)
      if (entity && typeof entity.attachSession === 'function') await entity.attachSession(sessionId)
    }
  }
}
