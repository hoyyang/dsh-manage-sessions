/** Cordis host entry for dsh-manage-sessions. */
import { existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Structural re-declaration of the legacy dsh-agent deletion-reservation
 * result. The rc.8 refresh stopped exporting the named type; the host methods
 * themselves stay feature-detected at runtime (absent hosts simply leave the
 * capability off), so this local shape only serves the adapter's typing.
 */
interface SessionDeletionReservationResult {
  ok: boolean
  reservationToken: string
  disposedIds: readonly string[]
  blockers: Array<{
    id: unknown
    status: 'running' | 'attached-legacy' | 'config-identity' | 'deletion-reserved' | 'disposal-failed'
    cause?: string
  }>
}
import { PluginStateStore } from './state.ts'
import { recoverState, type RecoveryLogger } from './recovery.ts'
import { SessionManagerService } from './session-service.ts'
import { mountSessionManagerRoutes } from './routes.ts'
import type {
  HostAgents,
  HostProjectionCache,
  HostProjections,
  HostServices,
  HostSessionPersistence,
  HostWorkspaceRegistry,
  LiveAgentLike,
  RecoveryReport,
  SessionMetaLike,
  WebServerLike,
} from './types.ts'

export const name = 'dsh-manage-sessions'
export const version = '0.4.1'

export interface Config {
  /** Plugin-owned metadata/journal root. Must stay outside the sessions root. */
  stateDir?: string
}

export interface HostSetup {
  state: PluginStateStore
  recovery: RecoveryReport
  service: SessionManagerService
  dispose(): void
}

/**
 * Open plugin state, reconcile any prior transaction, then expose routes.
 * Exported as a deterministic test seam; no route is visible before recovery.
 */
export async function setupHost(
  services: HostServices,
  stateDir: string,
  pluginVersion = version,
  logger?: RecoveryLogger,
): Promise<HostSetup> {
  const state = await PluginStateStore.open(stateDir)
  const recovery = await recoverState(state, {
    workspaces: services.workspaces,
    releaseReservation: services.agents?.releaseSessionDeletionReservation,
  }, logger)
  const service = new SessionManagerService(services, state)
  if (!services.webServer) throw new Error('ctx.webServer is unavailable')
  const dispose = mountSessionManagerRoutes(services.webServer, service, {
    version: pluginVersion,
    state,
    recovery,
  })
  return { state, recovery, service, dispose }
}

/** Canonicalize an absolute path through its deepest existing ancestor. */
function canonicalizeProspectivePath(path: string): string {
  const missing: string[] = []
  let cursor = resolve(path)
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

/** Reject plugin state inside the canonical JSONL persistence root. */
export function safeStateDir(configured?: string, sessionsRoot = dshHomePath('sessions')): string {
  const candidate = canonicalizeProspectivePath(configured ?? dshHomePath('dsh-manage-sessions'))
  const sessions = canonicalizeProspectivePath(sessionsRoot)
  const fromSessions = relative(sessions, candidate)
  if (fromSessions === '' || (!fromSessions.startsWith('..') && !isAbsolute(fromSessions))) {
    throw new Error(`dsh-manage-sessions stateDir must be outside the sessions root (${sessions})`)
  }
  return candidate
}

/**
 * One-time migration: the plugin was renamed (v0.7.0, dsh-manage-sessions →
 * dsh-manage-sessions) and its state dir moved with it. When the new dir does
 * not exist yet and the legacy one does, move it wholesale — archive times and
 * the journal survive the rename. The legacy dir is left in place only when
 * the move fails; a missing legacy dir is the normal steady state.
 */
export function migrateLegacyStateDir(stateDir: string, logger?: (message: string) => void): string {
  try {
    if (existsSync(stateDir)) return stateDir
    const legacy = stateDir.replace(/dsh-manage-sessions$/, 'dsh-manage-sessions')
    if (legacy === stateDir || !existsSync(legacy)) return stateDir
    mkdirSync(dirname(stateDir), { recursive: true })
    renameSync(legacy, stateDir)
    logger?.('migrated legacy plugin state dir ' + legacy + ' -> ' + stateDir)
  } catch (error) {
    logger?.('legacy state dir migration failed (continuing with a fresh dir): ' + String(error))
  }
  return stateDir
}

/**
 * Runtime self-heal for the restore (恢复活跃) capability. The native
 * `unarchiveSession` method is supplied by the plugin's core patch; a DSH
 * upgrade or reinstall restores pristine core files and silently drops it,
 * which fail-closes every restore button (capabilities captured at apply time).
 * When the live registry lacks the method but exposes the canonical mutation
 * primitives, installing the exact core-patch body keeps the current process
 * working without a restart. After a host restart with the patch re-applied,
 * the native method is present and this shim is skipped.
 *
 * Runs against the live `host.workspaceRegistry` boundary (never inside
 * `adaptHostServices`, whose probe contract keeps actual absence intact).
 */
export function ensureWorkspaceUnarchiveRuntime(
  host: unknown,
  warn?: (message: string) => void,
): boolean {
  const registry = (host as { workspaceRegistry?: unknown } | null | undefined)?.workspaceRegistry
  if (typeof registry !== 'object' || registry === null) return false
  const live = registry as {
    unarchiveSession?: unknown
    enqueueOperation?: unknown
    requireState?: unknown
    setState?: unknown
  }
  if (typeof live.unarchiveSession === 'function') return false
  if (
    typeof live.enqueueOperation !== 'function' ||
    typeof live.requireState !== 'function' ||
    typeof live.setState !== 'function'
  ) {
    return false
  }
  const primitives = live as {
    enqueueOperation(operation: () => Promise<void>): Promise<void>
    requireState(): { archivedSessionIds: readonly SessionId[] }
    setState(state: { archivedSessionIds: readonly SessionId[] } & Record<string, unknown>): Promise<void>
    unarchiveSession?(sessionId: SessionId): Promise<void>
  }
  // Canonical body copied verbatim from scripts/core-patch.mjs (CORE_PATCH_V1).
  primitives.unarchiveSession = (sessionId: SessionId): Promise<void> =>
    primitives.enqueueOperation(async () => {
      const state = primitives.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await primitives.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      })
    })
  warn?.(
    'workspaceRegistry.unarchiveSession missing from this host (core patch absent); installed a runtime shim — re-run scripts/core-patch.mjs --apply and restart DSH to restore native support',
  )
  return true
}

/**
 * Last event time through the host's sequenced accessors. DSH 0.1.5 stopped
 * exposing a public `session.events` array; `eventAt(seq - 1)` reads the same
 * fact in O(1) instead of materialising the whole log.
 */
function lastEventTime(session: unknown): number | null {
  const surface = session as {
    seq?: unknown
    eventAt?: (seq: unknown) => { time?: unknown } | undefined
  }
  const seq = surface.seq
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0 || typeof surface.eventAt !== 'function') return null
  try {
    const time = surface.eventAt.call(session, seq - 1)?.time
    return typeof time === 'number' && Number.isFinite(time) ? time : null
  } catch {
    return null
  }
}

/** Narrow one live agent to the plugin's structural host contract. */
function toLiveAgent(agent: Agent): LiveAgentLike {
  return {
    id: String(agent.id),
    status: agent.status,
    session: {
      id: String(agent.session.id),
      header: agent.session.header,
      latestEventTime: () => lastEventTime(agent.session),
    },
  }
}

/** Convert the branded public DSH services to the narrow testable host surface. */
export function adaptHostServices(ctx: Context): HostServices {
  const host = ctx as Context & {
    agents: {
      list(): Agent[]
      get(id: SessionId): Agent | undefined
      sessionDisposalStatus?(id: SessionId): 'cold' | 'idle' | 'running' | 'attached-legacy' | 'config-identity' | 'deletion-reserved'
      reserveSessionsForDeletion?(ids: readonly SessionId[]): Promise<SessionDeletionReservationResult>
      releaseSessionDeletionReservation?(token: string): void
      resume?(options: { resumeSessionId: SessionId; agentOptions?: unknown }): Promise<unknown>
    }
    workspaceRegistry: {
      list(): Array<{ id: unknown; path: string; title: string; createdAt: string; updatedAt: string; sessionIds: readonly SessionId[] }>
      get(id: unknown): { id: unknown; path: string; title: string; createdAt: string; updatedAt: string; sessionIds: readonly SessionId[] } | undefined
      readonly archivedSessionIds: readonly SessionId[]
      archiveSession(id: SessionId): Promise<void>
      forgetSession?(id: SessionId): Promise<void>
      unarchiveSession?(id: SessionId): Promise<void>
    }
    sessionPersistence: {
      /** 0.1.5 name of the rc.8 `listSnapshots()` catalogue read. */
      list?(options?: { signal?: AbortSignal }): Promise<readonly { header: SessionHeader; revision?: unknown }[]>
      /** 0.1.5 name of the rc.8 `inspect()` observer; `undefined` when unknown. */
      stat?(id: SessionId, options?: { signal?: AbortSignal }): Promise<{ header: SessionHeader } | undefined>
      /** jsonl backend artifact resolver (still present in 0.1.5, declared private upstream). */
      locate?(meta: SessionHeader): { kind: string; path: string } | undefined
    }
    sessionProjections: { snapshot?(session: Session): { asOfSeq: number; values?: Partial<Record<string, unknown>> } }
    sessionProjectionCache: {
      coldSnapshot?(id: SessionId, signal?: AbortSignal): Promise<{ asOfSeq: number; values?: Partial<Record<string, unknown>> }>
      cachedSnapshot?(meta: SessionHeader): { asOfSeq: number; values?: Partial<Record<string, unknown>> } | undefined
    }
    webServer: WebServerLike
  }

  const agents: HostAgents = {
    list: () => host.agents.list().map(toLiveAgent),
    get: (id) => {
      const agent = host.agents.get(id as SessionId)
      return agent === undefined ? undefined : toLiveAgent(agent)
    },
    ...(typeof host.agents.sessionDisposalStatus === 'function'
      ? { sessionDisposalStatus: (id: string) => host.agents.sessionDisposalStatus!(id as SessionId) }
      : {}),
    ...(typeof host.agents.reserveSessionsForDeletion === 'function'
      ? { reserveSessionsForDeletion: async (ids: readonly string[]) => {
          const result = await host.agents.reserveSessionsForDeletion!(ids as readonly SessionId[])
          return result.ok
            ? { ok: true as const, reservationToken: result.reservationToken, disposedIds: result.disposedIds.map(String) }
            : { ok: false as const, blockers: result.blockers.map((item) => ({ id: String(item.id), status: item.status, ...(item.cause === undefined ? {} : { cause: item.cause }) })) }
        } }
      : {}),
    ...(typeof host.agents.releaseSessionDeletionReservation === 'function'
      ? { releaseSessionDeletionReservation: (token: string) => host.agents.releaseSessionDeletionReservation!(token) }
      : {}),
    stop: (id, keepInbox) => {
      const agent = host.agents.get(id as SessionId)
      if (agent === undefined) return
      const surface = agent as unknown as { cancel?: (cause: unknown, options?: { keepInbox?: boolean }) => void }
      if (typeof surface.cancel !== 'function') throw new Error(`live agent "${id}" does not expose cancel() on this host`)
      surface.cancel({ kind: 'user' }, { keepInbox })
    },
    peek: (id) => {
      const agent = host.agents.get(id as SessionId)
      if (agent === undefined) return { attached: false, running: false, inbox: null, subagent: false }
      const header: SessionMetaLike = agent.session.header
      const inbox: unknown = (agent as unknown as { inbox?: unknown }).inbox
      const length = (inbox as { length?: unknown } | undefined)?.length
      const size = (inbox as { size?: unknown } | undefined)?.size
      const count = typeof length === 'number' && Number.isFinite(length)
        ? length
        : typeof size === 'number' && Number.isFinite(size) ? size : null
      return { attached: true, running: agent.status === 'running', inbox: count, subagent: header.origin === 'subagent' }
    },
    phaseReset: (id) => {
      const agent = host.agents.get(id as SessionId) as unknown as { setPhase?: (phase: { kind: string; lastTurn: unknown }) => void; phase?: { lastTurn?: unknown } } | undefined
      if (agent === undefined || typeof agent.setPhase !== 'function') {
        throw new Error(`live agent "${id}" does not expose setPhase on this host`)
      }
      const lastTurn = agent.phase?.lastTurn
      agent.setPhase({ kind: 'idle', lastTurn: typeof lastTurn === 'number' && Number.isFinite(lastTurn) ? lastTurn : 0 })
    },
    ...(typeof host.agents.resume === 'function'
      ? { resumeSession: async (id: string) => { await host.agents.resume!({ resumeSessionId: id as SessionId }) } }
      : {}),
  }
  const workspaces: HostWorkspaceRegistry = {
    list: () => host.workspaceRegistry.list().map((item) => ({
      id: String(item.id),
      path: item.path,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      sessionIds: item.sessionIds.map(String),
    })),
    get: (id) => {
      const item = host.workspaceRegistry.get(id)
      return item ? {
        id: String(item.id), path: item.path, title: item.title,
        createdAt: item.createdAt, updatedAt: item.updatedAt,
        sessionIds: item.sessionIds.map(String),
      } : undefined
    },
    get archivedSessionIds() { return host.workspaceRegistry.archivedSessionIds.map(String) },
    archiveSession: (id) => host.workspaceRegistry.archiveSession(id as SessionId),
    ...(typeof host.workspaceRegistry.forgetSession === 'function'
      ? { forgetSession: (id: string) => host.workspaceRegistry.forgetSession!(id as SessionId) }
      : {}),
    ...(typeof host.workspaceRegistry.unarchiveSession === 'function'
      ? { unarchiveSession: (id: string) => host.workspaceRegistry.unarchiveSession!(id as SessionId) }
      : {}),
  }
  // Every member is spread conditionally: the capability probe must observe the
  // REAL host surface. Wrapping an absent method unconditionally made
  // `has(listSnapshots)` true on DSH 0.1.5 and let /archive advertise success
  // while every call died with "listSnapshots is not a function".
  const persistence: HostSessionPersistence = {
    ...(typeof host.sessionPersistence.list === 'function'
      ? { listSnapshots: async (signal?: AbortSignal) => [...await host.sessionPersistence.list!({ signal })] }
      : {}),
    ...(typeof host.sessionPersistence.stat === 'function'
      ? { inspect: async (id: string, signal?: AbortSignal) => {
          const snapshot = await host.sessionPersistence.stat!(id as SessionId, { signal })
          if (snapshot === undefined) throw new Error(`session ${id} is absent from host persistence`)
          return { meta: snapshot.header }
        } }
      : {}),
    ...(typeof host.sessionPersistence.locate === 'function'
      ? { locate: (meta: Parameters<NonNullable<HostSessionPersistence['locate']>>[0]) => host.sessionPersistence.locate!(meta as SessionHeader) }
      : {}),
  }
  const projections: HostProjections = {
    ...(typeof host.sessionProjections.snapshot === 'function'
      ? { snapshot: (session: Parameters<NonNullable<HostProjections['snapshot']>>[0]) => host.sessionProjections.snapshot!(session as Session) }
      : {}),
  }
  const projectionCache: HostProjectionCache = {
    ...(typeof host.sessionProjectionCache.coldSnapshot === 'function'
      ? { coldSnapshot: (id: string, signal?: AbortSignal) => host.sessionProjectionCache.coldSnapshot!(id as SessionId, signal) }
      : {}),
    ...(typeof host.sessionProjectionCache.cachedSnapshot === 'function'
      ? { cachedSnapshot: (meta: Parameters<NonNullable<HostProjectionCache['cachedSnapshot']>>[0]) => host.sessionProjectionCache.cachedSnapshot!(meta as SessionHeader) }
      : {}),
  }
  return {
    agents,
    workspaces,
    persistence,
    projections,
    projectionCache,
    webServer: host.webServer,
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const stateDir = migrateLegacyStateDir(safeStateDir(config.stateDir))
  ctx.inject([
    'agents',
    'workspaceRegistry',
    'sessionPersistence',
    'sessionProjections',
    'sessionProjectionCache',
    'webServer',
  ], async (hostCtx) => {
    const namedLogger = hostCtx.logger('dsh-manage-sessions')
    const logger: RecoveryLogger = {
      info: (message) => namedLogger.info(message),
      warn: (message) => namedLogger.warn(message),
    }
    ensureWorkspaceUnarchiveRuntime(hostCtx, logger.warn)
    const setup = await setupHost(adaptHostServices(hostCtx), stateDir, version, logger)
    return setup.dispose
  })
}
