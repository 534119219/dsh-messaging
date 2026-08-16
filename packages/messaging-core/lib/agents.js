/**
 * Agent lifecycle for messaging chats.
 *
 * Mirrors the web host's canonical creation path (dsh-host-apiproxy):
 *   - single-flight creation per session id (concurrent same-id creation is
 *     unsupported by the registry),
 *   - resume when the session is already persisted, create otherwise,
 *   - setup composes the agent's scoped world: install the model selection
 *     (agentDefaultModel) and mount the default agent preset when a roster
 *     exists,
 *   - agentOptions provider/model come from ctx.agentDefaultModel.currentSelection().
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { attachSessionToPlatformWorkspace, ensureWorkspaceDir } from './workspaces.js'

export function createAgentManager(ctx, { logger }) {
  /** sessionId -> AgentHandle */
  const handles = new Map()
  /** sessionId -> in-flight creation promise */
  const creations = new Map()

  /** Install the live model selection on an unpublished agent scope. */
  function installSelection(agentCtx) {
    const agent = agentCtx.agent
    if (!agent) throw new Error('messaging: agent setup has no scoped agent')
    const defaults = ctx.get('agentDefaultModel')
    if (!defaults || typeof defaults.currentSelection !== 'function') return
    const selection = {
      get current() {
        return defaults.currentSelection()
      },
      set current(next) { /* per-session override unsupported in M0 */ },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
  }

  /** Resolve the default preset and build the pre-publication setup. */
  async function composeSetup() {
    const presets = ctx.get('agentPresets')
    if (!presets) {
      return { agentPreset: undefined, setup: async (agentCtx) => { installSelection(agentCtx) } }
    }
    const resolved = await presets.resolve(undefined)
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        installSelection(agentCtx)
        await presets.mount(agentCtx, resolved.id)
      },
    }
  }

  function modelOptions() {
    const defaults = ctx.get('agentDefaultModel')
    const selection = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
    if (!selection) return {}
    return { provider: selection.provider, model: selection.model }
  }

  /** Resolve the live agent for a session id, creating/resuming it once. */
  async function ensureAgent(sessionId, opts = {}) {
    const live = ctx.agents.get(sessionId)
    if (live) return live
    let creation = creations.get(sessionId)
    if (!creation) {
      creation = (async () => {
        const persistence = ctx.get('sessionPersistence')
        let stored = false
        if (persistence) {
          try {
            stored = (await persistence.list()).some((header) => header.id === sessionId)
          } catch (error) {
            logger.warn(`sessionPersistence.list failed: ${error.message}`)
          }
        }
        const composition = await composeSetup()
        const agentOptions = modelOptions()
        const cwd = opts && opts.cwd ? opts.cwd : process.cwd()
        const handle = stored
          ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup: composition.setup })
          : await ctx.agents.create({
              sessionId,
              agentOptions,
              meta: {
                cwd,
                ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}),
              },
              setup: composition.setup,
            })
        handles.set(sessionId, handle)
        // Attribute the session to its platform workspace (best-effort, with
        // retries so the session header is persisted before the attach).
        if (opts && opts.platform) {
          const attach = (attempt) => {
            attachSessionToPlatformWorkspace(ctx, opts.platform, sessionId, opts.label).catch(() => {
              if (attempt < 3) setTimeout(() => attach(attempt + 1), 1500)
            })
          }
          attach(0)
        }
        return handle.agent
      })().catch((error) => {
        const concurrent = ctx.agents.get(sessionId)
        if (concurrent) return concurrent
        throw error
      }).finally(() => {
        creations.delete(sessionId)
      })
      creations.set(sessionId, creation)
    }
    return creation
  }

  /** Resolve the per-platform workspace directory (created on demand). */
  function workspaceFor(platform) {
    return ensureWorkspaceDir(platform)
  }

  /** Tear down one owned agent (used by /new). */
  async function disposeAgent(sessionId) {
    const handle = handles.get(sessionId)
    if (!handle) return
    handles.delete(sessionId)
    await handle.dispose()
  }

  /** Tear down every owned agent (plugin disposal). */
  async function disposeAll() {
    const owned = [...handles.values()]
    handles.clear()
    for (const handle of owned) {
      try {
        await handle.dispose()
      } catch (error) {
        logger.warn(`agent dispose failed: ${error.message}`)
      }
    }
  }

  return { ensureAgent, workspaceFor, disposeAgent, disposeAll }
}
