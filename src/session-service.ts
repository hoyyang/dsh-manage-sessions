/**
 * Canonical host owner for catalog reads and serialized archive/delete mutations.
 * Routes only validate transport data and delegate here.
 */
import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { probeCapabilities, missingForCapability } from './capabilities.ts'
import { validateSessionArtifactPath } from './encode.ts'
import { Mutex, pathExists, PluginStateStore, removeTrashDir, trashPathFor } from './state.ts'
import type {
  ApiError,
  ApiResult,
  ArchiveSuccess,
  CatalogPayload,
  WorkspaceListPayload,
  ContextBreakdownView,
  ContextPressureView,
  DeleteJournal,
  DeleteSuccess,
  ForceStopMode,
  ForceStopSuccess,
  HostServices,
  UnarchiveSuccess,
  LiveSessionLike,
  ProjectionSnapshotLike,
  SessionInfo,
  SessionMetaLike,
  SessionProjectionView,
  SessionStatsView,
  StagedEntry,
  TokenUsageView,
} from './types.ts'

export interface SessionManagerFileOps {
  exists(path: string): Promise<boolean>
  rename(from: string, to: string): Promise<void>
  removeTrash(path: string): Promise<void>
}

const defaultFileOps: SessionManagerFileOps = {
  exists: pathExists,
  rename,
  removeTrash: removeTrashDir,
}

export class SessionManagerService {
  readonly capabilities
  private readonly mutex = new Mutex()

  constructor(
    private readonly services: HostServices,
    private readonly state: PluginStateStore,
    private readonly fileOps: SessionManagerFileOps = defaultFileOps,
  ) {
    this.capabilities = probeCapabilities(services, state.isReady())
  }

  /**
   * Registry-only workspace metadata (id/title/path) for the sidebar
   * copy-path bridge: no persistence scans, no projections — the catalog
   * route stays heavyweight on purpose, this one exists to be instant.
   */
  async workspaceList(): Promise<ApiResult<WorkspaceListPayload>> {
    const { workspaces } = this.services
    if (!workspaces || typeof workspaces.list !== 'function') {
      return fail('capability-missing', 'workspace listing is unavailable on this host', { missing: ['ctx.workspaceRegistry'] })
    }
    return { ok: true, workspaces: workspaces.list().map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path })) }
  }

  async catalog(): Promise<CatalogPayload> {
    const { persistence, workspaces, agents } = this.services
    if (!persistence || !workspaces || !agents || !this.capabilities.catalog) {
      throw new Error('session catalog services are unavailable')
    }
    const snapshotReader = persistence.listSnapshots
    if (snapshotReader === undefined) throw new Error('session catalog services are unavailable')
    const snapshots = await snapshotReader()
    const liveById = new Map(agents.list().map((agent) => [agent.id, agent]))
    const metaById = new Map<string, SessionMetaLike>()
    for (const snapshot of snapshots) {
      const id = stringId(snapshot.header.id)
      if (id) metaById.set(id, snapshot.header)
    }
    for (const [id, agent] of liveById) if (!metaById.has(id)) metaById.set(id, agent.session.header)

    const archivedIds = [...new Set(workspaces.archivedSessionIds.map(String))]
    const archivedSet = new Set(archivedIds)
    const infoById = new Map<string, SessionInfo>()
    await Promise.all([...metaById].map(async ([id, meta]) => {
      const live = liveById.get(id)
      const projections = await this.projectionFor(id, meta, live?.session)
      const stats = projections.stats
      const updatedAt = live?.session.latestEventTime?.() ?? latestFiniteEventTime(live?.session.events) ?? finiteNumber(meta.createdAt)
      infoById.set(id, {
        id,
        status: this.services.agents?.sessionDisposalStatus?.(id) ?? (live ? (live.status === 'running' ? 'running' : 'attached-legacy') : 'cold'),
        running: live?.status === 'running',
        createdAt: finiteNumber(meta.createdAt),
        updatedAt,
        cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
        parent: stringId(meta.parentSession),
        subagent: meta.origin === 'subagent',
        delegationDepth: finiteNumber(meta.delegationDepth) ?? 0,
        archived: archivedSet.has(id),
        archiveTime: archivedSet.has(id) ? this.state.archiveTimeOf(id) : null,
        agentWorkMs: stats ? stats.llmMs + stats.toolMs : null,
        ...projections,
      })
    }))

    const accounted = new Set<string>()
    const workspaceGroups = workspaces.list().map((workspace) => {
      const sessionIds = workspace.sessionIds.map(String).filter((id) => infoById.has(id))
      for (const id of sessionIds) accounted.add(id)
      return {
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
        createdAt: workspace.createdAt ?? null,
        updatedAt: workspace.updatedAt ?? null,
        sessionIds,
        sessions: sessionIds.map((id) => infoById.get(id)!),
      }
    })
    const orphanIds = [...infoById.keys()].filter((id) => !accounted.has(id))
    const archivedSessions = archivedIds.flatMap((id) => {
      const info = infoById.get(id)
      return info ? [info] : []
    })
    const activeSessions = [...infoById.values()].filter((info) => !info.archived)

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      capabilities: this.capabilities,
      workspaces: workspaceGroups,
      orphans: { sessionIds: orphanIds, sessions: orphanIds.map((id) => infoById.get(id)!) },
      archivedSessionIds: archivedIds,
      archived: archivedSessions,
      activeSessions,
      archivedSessions,
    }
  }

  archive(ids: readonly unknown[]): Promise<ApiResult<ArchiveSuccess>> {
    return this.mutex.run(async () => {
      const normalized = normalizeIds(ids)
      if (!normalized.ok) return normalized
      const workspaces = this.services.workspaces
      if (!workspaces || !this.capabilities.archive) return fail('capability-missing', 'archive capability is unavailable', {
        missing: [
          ...missingForCapability(this.services, 'archive'),
          ...(!this.state.isReady() ? [`plugin state: ${this.state.stateError() ?? 'not ready'}`] : []),
        ],
      })
      let known: Set<string>
      try { known = await this.knownIds() } catch (error) {
        return fail('persistence-failed', 'could not list persisted sessions', { cause: errorMessage(error) })
      }
      const unknown = normalized.ids.filter((id) => !known.has(id))
      if (unknown.length > 0) return fail('unknown-session', 'one or more sessions are unknown', { ids: unknown })

      const archivedBefore = new Set(workspaces.archivedSessionIds.map(String))
      const alreadyArchivedIds = normalized.ids.filter((id) => archivedBefore.has(id))
      const pending = normalized.ids.filter((id) => !archivedBefore.has(id))
      if (pending.length > 1 && typeof workspaces.unarchiveSession !== 'function') {
        return fail('capability-missing', 'atomic multi-session archive requires unarchive compensation on this host', {
          missing: ['ctx.workspaceRegistry.unarchiveSession'],
        })
      }
      const archivedNow: string[] = []
      try {
        for (const id of pending) {
          await workspaces.archiveSession(id)
          archivedNow.push(id)
        }
      } catch (error) {
        const rollbackErrors: string[] = []
        if (workspaces.unarchiveSession) {
          for (const id of [...archivedNow].reverse()) {
            try { await workspaces.unarchiveSession(id) } catch (rollbackError) { rollbackErrors.push(`${id}: ${errorMessage(rollbackError)}`) }
          }
        }
        return fail('archive-partial', 'archive batch failed before timestamp commit', {
          cause: errorMessage(error),
          archivedBeforeFailure: archivedNow,
          rollbackErrors,
        })
      }

      const stamp = new Date().toISOString()
      const times = { ...this.state.archiveTimes() }
      const committed: Record<string, string> = {}
      for (const id of archivedNow) committed[id] = times[id] = stamp
      try {
        await this.state.writeArchiveTimes(times)
      } catch (error) {
        const rollbackErrors: string[] = []
        if (workspaces.unarchiveSession) {
          for (const id of [...archivedNow].reverse()) {
            try { await workspaces.unarchiveSession(id) } catch (rollbackError) { rollbackErrors.push(`${id}: ${errorMessage(rollbackError)}`) }
          }
        }
        return fail('archive-times-failed', 'official archive succeeded but archive-time commit failed', {
          cause: errorMessage(error),
          rollbackErrors,
        })
      }
      return { ok: true, archivedIds: archivedNow, archiveTimes: committed, alreadyArchivedIds }
    })
  }

  unarchive(ids: readonly unknown[]): Promise<ApiResult<UnarchiveSuccess>> {
    return this.mutex.run(async () => {
      const normalized = normalizeIds(ids)
      if (!normalized.ok) return normalized
      const workspaces = this.services.workspaces
      if (!workspaces || !this.capabilities.unarchiveAvailable || typeof workspaces.unarchiveSession !== 'function') {
        return fail('capability-missing', 'restore capability is unavailable', {
          missing: [
            ...(!workspaces ? ['ctx.workspaceRegistry'] : []),
            ...(workspaces && typeof workspaces.unarchiveSession !== 'function' ? ['ctx.workspaceRegistry.unarchiveSession'] : []),
            ...(!this.state.isReady() ? [`plugin state: ${this.state.stateError() ?? 'not ready'}`] : []),
          ],
        })
      }
      let known: Set<string>
      try { known = await this.knownIds() } catch (error) {
        return fail('persistence-failed', 'could not list persisted sessions', { cause: errorMessage(error) })
      }
      const unknown = normalized.ids.filter((id) => !known.has(id))
      if (unknown.length > 0) return fail('unknown-session', 'one or more sessions are unknown', { ids: unknown })

      const archivedBefore = new Set(workspaces.archivedSessionIds.map(String))
      const alreadyActiveIds = normalized.ids.filter((id) => !archivedBefore.has(id))
      const pending = normalized.ids.filter((id) => archivedBefore.has(id))
      const unarchivedNow: string[] = []
      try {
        for (const id of pending) {
          await workspaces.unarchiveSession(id)
          unarchivedNow.push(id)
        }
      } catch (error) {
        const rollbackErrors: string[] = []
        for (const id of [...unarchivedNow].reverse()) {
          try { await workspaces.archiveSession(id) } catch (rollbackError) { rollbackErrors.push(`${id}: ${errorMessage(rollbackError)}`) }
        }
        return fail('archive-partial', 'restore batch failed before metadata commit', {
          cause: errorMessage(error),
          unarchivedBeforeFailure: unarchivedNow,
          rollbackErrors,
        })
      }

      const preservedTimes = { ...this.state.archiveTimes() }
      for (const id of unarchivedNow) delete preservedTimes[id]
      try {
        await this.state.writeArchiveTimes(preservedTimes)
      } catch (error) {
        const rollbackErrors: string[] = []
        for (const id of [...unarchivedNow].reverse()) {
          try { await workspaces.archiveSession(id) } catch (rollbackError) { rollbackErrors.push(`${id}: ${errorMessage(rollbackError)}`) }
        }
        return fail('archive-times-failed', 'official restore succeeded but archive-time commit failed', {
          cause: errorMessage(error),
          rollbackErrors,
        })
      }
      return {
        ok: true,
        unarchivedIds: unarchivedNow,
        alreadyActiveIds,
        archivedSessionIds: workspaces.archivedSessionIds.map(String),
      }
    })
  }

  delete(ids: readonly unknown[]): Promise<ApiResult<DeleteSuccess>> {
    return this.mutex.run(async () => {
      const normalized = normalizeIds(ids)
      if (!normalized.ok) return normalized
      const { agents, persistence, workspaces } = this.services
      if (!agents?.reserveSessionsForDeletion || !agents.releaseSessionDeletionReservation || !persistence?.inspect || !persistence.locate || !workspaces?.forgetSession || !this.capabilities.delete) {
        return fail('capability-missing', 'permanent-delete capability is unavailable', {
          missing: [
            ...missingForCapability(this.services, 'delete'),
            ...(!this.state.isReady() ? [`plugin state: ${this.state.stateError() ?? 'not ready'}`] : []),
          ],
        })
      }
      try {
        const pending = await this.state.readJournal()
        if (pending) return fail('blocked', 'a prior delete transaction requires recovery before another delete can start', {
          pendingJournal: { txnId: pending.txnId, phase: pending.phase },
        })
      } catch (error) {
        return fail('journal-failed', 'pending delete journal cannot be read safely', { cause: errorMessage(error) })
      }
      let known: Set<string>
      try { known = await this.knownIds() } catch (error) {
        return fail('persistence-failed', 'could not list persisted sessions', { cause: errorMessage(error) })
      }
      const unknown = normalized.ids.filter((id) => !known.has(id))
      if (unknown.length > 0) return fail('unknown-session', 'one or more sessions are unknown', { ids: unknown })

      let reservation
      try { reservation = await agents.reserveSessionsForDeletion(normalized.ids) } catch (error) {
        return fail('disposal-failed', 'agent deletion reservation failed', { cause: errorMessage(error) })
      }
      if (!reservation.ok) return fail('blocked', 'the complete delete batch was rejected', { blockers: reservation.blockers })

      let retainReservationUntilRestart = false
      try {
        const txnId = randomUUID()
      const entries: StagedEntry[] = []
      try {
        for (const id of normalized.ids) {
          const inspection = await persistence.inspect(id)
          const location = persistence.locate(inspection.meta)
          if (!location || location.kind !== 'jsonl') return fail('artifact-not-locatable', `session ${id} has no independently locatable JSONL artifact`, { id, disposedIds: reservation.disposedIds })
          const checked = validateSessionArtifactPath(location.path, id)
          if (!checked.ok) return fail('unsafe-location', `refusing to stage session ${id}`, { id, reason: checked.reason, disposedIds: reservation.disposedIds })
          entries.push({
            id,
            original: checked.dir,
            staged: trashPathFor(checked.dir, txnId),
            preexisting: await this.fileOps.exists(checked.dir),
            artifactOriginal: location.path,
            artifactHiddenName: `.dsh-manage-sessions-artifact-${txnId}`,
          })
        }
      } catch (error) {
        return fail('inspect-failed', 'session retirement/inspection failed', { cause: errorMessage(error), disposedIds: reservation.disposedIds })
      }

      const journal: DeleteJournal = {
        version: 1,
        txnId,
        reservationToken: reservation.reservationToken,
        ids: normalized.ids,
        entries,
        phase: 'staging',
        startedAt: new Date().toISOString(),
      }
      try { await this.state.writeJournal(journal) } catch (error) {
        return fail('journal-failed', 'could not persist delete journal', { cause: errorMessage(error), disposedIds: reservation.disposedIds })
      }

      const staged: StagedEntry[] = []
      try {
        for (const entry of entries) {
          if (!entry.preexisting) continue
          await this.fileOps.rename(entry.artifactOriginal, join(entry.original, entry.artifactHiddenName))
          await this.fileOps.rename(entry.original, entry.staged)
          staged.push(entry)
        }
        journal.phase = 'staged'
        await this.state.writeJournal(journal)
      } catch (error) {
        const rollbackErrors = await this.restore(entries)
        if (rollbackErrors.length > 0) retainReservationUntilRestart = true
        if (rollbackErrors.length === 0) await this.state.clearJournal().catch(() => {})
        return fail(rollbackErrors.length === 0 ? 'staging-failed' : 'staging-rollback-incomplete', 'session artifact staging failed', {
          cause: errorMessage(error),
          rollbackErrors,
          disposedIds: reservation.disposedIds,
        })
      }

      // This durable edge is the point of no return. Recovery forward-commits.
      journal.phase = 'committing'
      try { await this.state.writeJournal(journal) } catch (error) {
        const rollbackErrors = await this.restore(staged)
        if (rollbackErrors.length > 0) retainReservationUntilRestart = true
        if (rollbackErrors.length === 0) await this.state.clearJournal().catch(() => {})
        return fail(rollbackErrors.length === 0 ? 'journal-failed' : 'staging-rollback-incomplete', 'could not enter metadata commit phase', {
          cause: errorMessage(error),
          rollbackErrors,
          disposedIds: reservation.disposedIds,
        })
      }
      retainReservationUntilRestart = true

      try {
        for (const id of normalized.ids) await workspaces.forgetSession(id)
      } catch (error) {
        return fail('forget-failed', 'official workspace cleanup did not finish; recovery will forward-commit', {
          cause: errorMessage(error),
          txnId,
          disposedIds: reservation.disposedIds,
        })
      }
      try {
        await this.state.removeArchiveTimesFor(normalized.ids)
        journal.phase = 'committed'
        await this.state.writeJournal(journal)
        retainReservationUntilRestart = false
      } catch (error) {
        return fail('commit-failed', 'delete metadata commit did not finish; recovery will forward-commit', {
          cause: errorMessage(error),
          txnId,
          disposedIds: reservation.disposedIds,
        })
      }

      const pendingCleanup: string[] = []
      for (const entry of staged) {
        try { await this.fileOps.removeTrash(entry.staged) } catch { pendingCleanup.push(entry.staged) }
      }
      if (pendingCleanup.length === 0) await this.state.clearJournal().catch(() => {})
      return { ok: true, deletedIds: normalized.ids, disposedIds: reservation.disposedIds, pendingCleanup }
      } finally {
        if (!retainReservationUntilRestart) agents.releaseSessionDeletionReservation(reservation.reservationToken)
      }
    })
  }

  /**
   * Force-stop one session's running activity with verification and escalation:
   * cancel (official semantics) → poll → scope dispose → poll → phase reset.
   * Deliberately NOT queued behind the plugin mutex: a hung operation elsewhere
   * must never block the escape hatch this feature exists for.
   */
  async forceStop(
    id: unknown,
    mode: unknown,
    budgets: { pollMs?: number; cancelMs?: number; resetMs?: number } = {},
  ): Promise<ApiResult<ForceStopSuccess>> {
    if (typeof id !== 'string' || id.trim() === '' || id.length > 256) {
      return fail('invalid-request', 'session id must be a non-empty string of at most 256 characters')
    }
    if (mode !== 'resume' && mode !== 'offline') return fail('invalid-request', 'mode must be "resume" or "offline"')
    const agents = this.services.agents
    const forceMode: ForceStopMode = mode
    if (!agents?.stop || !agents.peek || !agents.phaseReset || !this.capabilities.forceStop) {
      return fail('capability-missing', 'force-stop capability is unavailable', {
        missing: missingForCapability(this.services, 'forceStop'),
      })
    }
    if (forceMode === 'resume' && (typeof agents.resumeSession !== 'function' || !this.capabilities.forceStopResume)) {
      return fail('capability-missing', 'auto-resume is unavailable on this host', { missing: ['ctx.agents.resume'] })
    }
    const started = Date.now()
    const pollMs = budgets.pollMs ?? 250
    const trace: string[] = []
    const peek = () => agents.peek!(id)
    const waitForStop = async (budgetMs: number): Promise<boolean> => {
      const deadline = Date.now() + budgetMs
      for (;;) {
        const state = peek()
        if (!state.attached || !state.running) return true
        if (Date.now() >= deadline) return false
        await sleep(pollMs)
      }
    }

    const before = peek()
    if (before.subagent) {
      return fail('blocked', 'subagent sessions are owned by their parent agent; force-stop refuses them', { id })
    }
    if (!before.attached) {
      // Nothing is running. Resume mode still materializes the session so kept
      // queued work continues; offline mode is an honest no-op.
      if (forceMode === 'offline') {
        return { ok: true, id, mode: forceMode, stoppedVia: 'not-running', attached: false, resumed: false, inboxAtStop: null, elapsedMs: Date.now() - started, trace }
      }
      trace.push('resume')
      try { await agents.resumeSession!(id) } catch (error) {
        return fail('force-stop-failed', 'could not resume the offline session', { cause: errorMessage(error), trace })
      }
      if (!peek().attached) return fail('force-stop-failed', 'session did not re-attach after resume', { id, trace })
      return { ok: true, id, mode: forceMode, stoppedVia: 'not-running', attached: true, resumed: true, inboxAtStop: null, elapsedMs: Date.now() - started, trace }
    }

    const inboxAtStop = before.inbox
    let stoppedVia: ForceStopSuccess['stoppedVia'] = 'not-running'
    if (before.running) {
      // Resume mode keeps the queued inbox (processed once idle); offline mode
      // deliberately abandons the in-memory queue — the session log keeps every
      // already-committed message either way.
      stoppedVia = 'cancel'
      trace.push('cancel')
      try { agents.stop(id, forceMode === 'resume') } catch (error) {
        return fail('force-stop-failed', 'live agent does not expose a usable cancel()', { cause: errorMessage(error), trace })
      }
      // ponytail: no scope.dispose here — a disposed cordis scope leaves a
      // dead machine attached to the live registry (verified: effect spawn on a
      // quiesced fiber throws), which bricks the NEXT turn. Phase reset keeps
      // the machine alive; a late settle of the hung await is at worst one
      // bounded error log on an already-broken session.
      if (!await waitForStop(budgets.cancelMs ?? 5_000)) {
        stoppedVia = 'phase-reset'
        trace.push('phase-reset')
        try { agents.phaseReset(id) } catch (error) { trace.push(`phase-reset-error: ${errorMessage(error)}`) }
        if (!await waitForStop(budgets.resetMs ?? 2_000)) {
          return fail('force-stop-failed', 'agent still reports running after cancel and phase reset', { id, trace })
        }
      }
    }

    let resumed = false
    let attached = peek().attached
    if (forceMode === 'resume') {
      if (!attached) {
        trace.push('resume')
        try { await agents.resumeSession!(id) } catch (error) {
          return fail('force-stop-failed', 'stop succeeded but auto-resume failed', { cause: errorMessage(error), trace, stoppedVia })
        }
        attached = peek().attached
        if (!attached) return fail('force-stop-failed', 'session did not re-attach after auto-resume', { id, trace, stoppedVia })
      }
      resumed = true
    }
    return { ok: true, id, mode: forceMode, stoppedVia, attached, resumed, inboxAtStop, elapsedMs: Date.now() - started, trace }
  }

  private async projectionFor(_id: string, meta: SessionMetaLike, liveSession?: LiveSessionLike): Promise<SessionProjectionView> {
    let snapshot: ProjectionSnapshotLike | undefined
    try {
      // Catalog enrichment must never load/fold a cold log. The official
      // session.list path is likewise cache-only so opening the manager stays
      // bounded even with hundreds of persisted sessions.
      snapshot = liveSession
        ? this.services.projections?.snapshot?.(liveSession)
        : this.services.projectionCache?.cachedSnapshot?.(meta)
    } catch {
      snapshot = undefined
    }
    const values = snapshot?.values ?? {}
    return {
      title: titleView(values.title),
      stats: statsView(values.sessionStats),
      tokenUsage: tokenView(values.tokenUsage),
      contextPressure: pressureView(values.contextPressure),
      contextBreakdown: breakdownView(values.contextBreakdown),
    }
  }

  private async knownIds(): Promise<Set<string>> {
    const snapshotReader = this.services.persistence?.listSnapshots
    if (snapshotReader === undefined) throw new Error('ctx.sessionPersistence.listSnapshots is unavailable on this host')
    const ids = new Set<string>()
    for (const snapshot of await snapshotReader()) {
      const id = stringId(snapshot.header.id)
      if (id) ids.add(id)
    }
    for (const agent of this.services.agents?.list() ?? []) ids.add(agent.id)
    return ids
  }

  private async restore(entries: readonly StagedEntry[]): Promise<string[]> {
    const errors: string[] = []
    for (const entry of [...entries].reverse()) {
      if (!entry.preexisting) continue
      try {
        const originalExists = await this.fileOps.exists(entry.original)
        const stagedExists = await this.fileOps.exists(entry.staged)
        if (!originalExists && stagedExists) await this.fileOps.rename(entry.staged, entry.original)
        const hidden = join(entry.original, entry.artifactHiddenName)
        if (await this.fileOps.exists(hidden)) await this.fileOps.rename(hidden, entry.artifactOriginal)
      } catch (error) {
        errors.push(`${entry.id}: ${errorMessage(error)}`)
      }
    }
    return errors
  }
}

function normalizeIds(values: readonly unknown[]): ({ ok: true; ids: string[] } | { ok: false; error: ApiError }) {
  if (!Array.isArray(values)) return fail('invalid-request', 'ids must be an array')
  const ids: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 256) return fail('invalid-request', 'every session id must be a non-empty string of at most 256 characters')
    if (!seen.has(value)) { seen.add(value); ids.push(value) }
  }
  return ids.length > 0 ? { ok: true, ids } : fail('empty-batch', 'at least one session id is required')
}

function fail(code: ApiError['code'], message: string, details?: Record<string, unknown>): { ok: false; error: ApiError } {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } }
}

function stringId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function latestFiniteEventTime(events: readonly { time?: unknown }[] | undefined): number | null {
  let latest: number | null = null
  for (const event of events ?? []) {
    const time = finiteNumber(event.time)
    if (time !== null && (latest === null || time > latest)) latest = time
  }
  return latest
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function titleView(value: unknown): string | null {
  const row = object(value)
  return row && typeof row.title === 'string' ? row.title : null
}

function statsView(value: unknown): SessionStatsView | null {
  const row = object(value)
  if (!row) return null
  const keys = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const
  if (!keys.every((key) => finiteNumber(row[key]) !== null)) return null
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as unknown as SessionStatsView
}

function tokenView(value: unknown): TokenUsageView | null {
  const row = object(value)
  if (!row) return null
  const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  if (!keys.every((key) => finiteNumber(row[key]) !== null)) return null
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as unknown as TokenUsageView
}

function pressureView(value: unknown): ContextPressureView | null {
  const row = object(value)
  if (!row) return null
  const result: ContextPressureView = {}
  for (const key of ['pressureTokens', 'projectedTokens', 'contextWindow'] as const) {
    const number = finiteNumber(row[key])
    if (number !== null) result[key] = number
  }
  return result
}

function breakdownView(value: unknown): ContextBreakdownView | null {
  const row = object(value)
  if (!row) return null
  const keys = ['systemTokens', 'toolsTokens', 'messageTokens'] as const
  if (!keys.every((key) => finiteNumber(row[key]) !== null)) return null
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as unknown as ContextBreakdownView
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
