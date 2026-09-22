/**
 * Wire and internal vocabulary of dsh-manage-sessions (host half).
 *
 * Compiled against the installed DSH rc.8 core contracts:
 * - ctx.agents.sessionDisposalStatus(id) / reserveSessionsForDeletion(ids) / releaseSessionDeletionReservation(token)
 * - ctx.workspaceRegistry.archiveSession / forgetSession (+ unarchiveSession when a host of top it provides one at runtime)
 * - ctx.sessionPersistence.inspect(id) / locate(meta)
 * - sessionProjectionCache.coldSnapshot(id) / sessionProjections.snapshot(liveSession)
 *
 * Wire payloads use plain JSON shapes; service dependencies are declared as
 * narrow structural interfaces so tests can exercise the transaction core with
 * fixtures and never touch real ~/.dsh data.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// Session vocabulary (mirrors the harness brands; strings on the wire)
// ---------------------------------------------------------------------------

/**
 * Disposal classification. `'unknown'` is this plugin's own fallback label
 * used only when the patched `sessionDisposalStatus` method is absent at
 * runtime — it is never asserted about the harness itself.
 */
export type SessionDisposalStatus = 'cold' | 'idle' | 'running' | 'attached-legacy' | 'config-identity' | 'deletion-reserved' | 'unknown'

/** Session-header-shaped metadata (the fields the catalog reads). */
export interface SessionMetaLike {
  readonly version?: number
  readonly id?: unknown
  readonly createdAt?: number
  readonly cwd?: string
  readonly parentSession?: unknown
  readonly origin?: 'subagent' | unknown
  readonly delegationDepth?: number
  readonly seedLength?: number
  readonly agentPreset?: unknown
}

/** One projection cut value bag (schema-validated by the host before it leaves). */
export interface ProjectionSnapshotLike {
  asOfSeq: number
  values?: Partial<Record<string, unknown>>
}

export interface SessionStatsView {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

export interface TokenUsageView {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ContextPressureView {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface ContextBreakdownView {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** Projection-derived fields served on one cut. Every field is null when the source is unavailable. */
export interface SessionProjectionView {
  title: string | null
  stats: SessionStatsView | null
  tokenUsage: TokenUsageView | null
  contextPressure: ContextPressureView | null
  contextBreakdown: ContextBreakdownView | null
}

/** One catalog entry (active or archived). */
export interface SessionInfo extends SessionProjectionView {
  id: string
  status: SessionDisposalStatus
  running: boolean
  createdAt: number | null
  /** Last known activity (live: latest event time; cold fallback: creation time). Null when unavailable. */
  updatedAt: number | null
  cwd: string | null
  parent: string | null
  subagent: boolean
  delegationDepth: number
  archived: boolean
  /**
   * Plugin-owned archive instant (ISO-8601), or null when the entry is an
   * archived session the plugin never archived itself (legacy). Never invented.
   */
  archiveTime: string | null
  /**
   * Derived activity total: `stats.llmMs + stats.toolMs`. Null when the stats
   * projection is unavailable.
   */
  agentWorkMs: number | null
}

/** One existing workspace: official registry metadata plus ordered members. */
export interface WorkspaceGroup {
  id: string
  path: string
  title: string
  createdAt: string | null
  updatedAt: string | null
  sessionIds: string[]
  sessions: SessionInfo[]
}

/** Synthetic group for persisted sessions not accounted by any workspace. */
export interface OrphanGroup {
  sessionIds: string[]
  sessions: SessionInfo[]
}

/** Lightweight workspace metadata list for the sidebar copy-path bridge. */
export interface WorkspaceListPayload {
  workspaces: Array<{ id: string; title: string; path: string }>
}

export interface CatalogPayload {
  ok: true
  generatedAt: string
  capabilities: HostCapabilities
  workspaces: WorkspaceGroup[]
  orphans: OrphanGroup
  /** Official archive membership in archive order. */
  archivedSessionIds: string[]
  /**
   * Flat archive collection in archive order, carrying the same full detail
   * as workspace/orphan entries (archived sessions keep their workspace slot
   * officially, so they appear in both places). An id with no resolvable
   * detail anywhere is omitted here but stays in `archivedSessionIds`.
   */
  archived: SessionInfo[]
  /** Flat detail for every non-archived entry (same ordering guarantees as the groups). */
  activeSessions: SessionInfo[]
  /** Flat detail for every archived entry; identical membership to `archived`. */
  archivedSessions: SessionInfo[]
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

export interface HostCapabilities {
  /** Catalog reads are possible (workspace registry + persistence listing). */
  catalog: boolean
  /** Patched sessionDisposalStatus present. */
  disposalStatus: boolean
  /** Patched atomic deletion reservation present. */
  disposeBatch: boolean
  /** Archive possible: official archiveSession present (single-id supported). */
  archive: boolean
  /**
   * Atomic MULTI-id archive batch possible. True only when the host exposes
   * BOTH `archiveSession` and `unarchiveSession`: a partially-failed batch
   * needs unarchive compensation to roll earlier archives back. The guarded
   * rc.8 compatibility patch supplies `unarchiveSession`; runtime presence is
   * still authoritative and any partial contract fails closed.
   */
  archiveBatch: boolean
  /** The host exposes unarchiveSession for compensation. */
  unarchiveAvailable: boolean
  /** Permanent delete possible: full contract chain present. */
  delete: boolean
  /** Plugin state store initialized (archive-times + journal ready). */
  stateReady: boolean
  /** Live projections available. */
  projectionsLive: boolean
  /** Cold projections (persisted cache ladder) available. */
  projectionsCold: boolean
  /** Force-stop surface present (agents.stop/peek/hardDispose/phaseReset adapters). */
  forceStop: boolean
  /** Force-stop plus auto-resume (host exposes ctx.agents.resume). */
  forceStopResume: boolean
}

export interface CapabilitiesPayload {
  ok: true
  capabilities: HostCapabilities
  version: string
}

// ---------------------------------------------------------------------------
// Errors / operation results
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'invalid-request'
  | 'invalid-body'
  | 'body-too-large'
  | 'empty-batch'
  | 'unknown-session'
  | 'blocked'
  | 'disposal-failed'
  | 'inspect-failed'
  | 'artifact-not-locatable'
  | 'unsafe-location'
  | 'staging-failed'
  | 'staging-rollback-incomplete'
  | 'forget-failed'
  | 'commit-failed'
  | 'capability-missing'
  | 'archive-partial'
  | 'archive-failed'
  | 'archive-times-failed'
  | 'journal-failed'
  | 'catalog-failed'
  | 'workspace-list-failed'
  | 'persistence-failed'
  | 'route-error'
  | 'force-stop-failed'

export interface ApiError {
  code: ApiErrorCode
  message: string
  details?: Record<string, unknown>
}

export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: ApiError }

export interface ArchiveSuccess {
  /** Normalized unique ids (request order) that are now officially archived. */
  archivedIds: string[]
  /** Plugins-owned committed timestamps for the ids newly archived by this batch. */
  archiveTimes: Record<string, string>
  /** Ids already archived before the batch (left legacy: no invented timestamp). */
  alreadyArchivedIds: string[]
}

export interface UnarchiveSuccess {
  /** Request-order ids removed from the official archive set by this batch. */
  unarchivedIds: string[]
  /** Known ids that were already active before the batch. */
  alreadyActiveIds: string[]
  /** Full official archive membership after the durable mutation. */
  archivedSessionIds: string[]
}

export interface DeleteSuccess {
  deletedIds: string[]
  disposedIds: string[]
  /** Trash entries still on disk; startup recovery finishes them. */
  pendingCleanup: string[]
}

export type ForceStopMode = 'resume' | 'offline'

/** Narrow live-agent observation used by force-stop decisions. */
export interface AgentPeek {
  attached: boolean
  running: boolean
  /** Queued in-memory inbox messages; null when unreadable on this host. */
  inbox: number | null
  /** Session originated as a subagent (force-stop refuses those). */
  subagent: boolean
}

export interface ForceStopSuccess {
  id: string
  mode: ForceStopMode
  /** How the running activity was stopped. */
  stoppedVia: 'not-running' | 'cancel' | 'phase-reset'
  /** Live registry state after the whole operation. */
  attached: boolean
  /** Whether the session is attached for continued processing (resume mode). */
  resumed: boolean
  /** Inbox depth observed before the stop; null when unreadable. */
  inboxAtStop: number | null
  elapsedMs: number
  /** Escalation steps actually taken, in order (cancel → dispose → phase-reset). */
  trace: string[]
}

// ---------------------------------------------------------------------------
// Host service surfaces (narrow structural contracts)
// ---------------------------------------------------------------------------

export interface LiveSessionLike {
  readonly id: string
  readonly header: SessionMetaLike
  /** rc.8 exposed the live event array; 0.1.5 exposes only sequenced accessors. */
  readonly events?: readonly { time?: number }[]
  /** Cheap last-event time read through the host's sequenced accessor (0.1.5). */
  latestEventTime?(): number | null
}

export interface LiveAgentLike {
  readonly id: string
  readonly status: 'idle' | 'running' | string
  readonly session: LiveSessionLike
}

/** Mirrors the patched core deletion-reservation result without exposing private owner state. */
export type BlockersResult =
  | { ok: true; reservationToken: string; disposedIds: string[] }
  | { ok: false; blockers: Array<{ id: string; status: 'running' | 'attached-legacy' | 'config-identity' | 'deletion-reserved' | 'disposal-failed'; cause?: string }> }

export interface HostAgents {
  list(): LiveAgentLike[]
  get(id: string): LiveAgentLike | undefined
  sessionDisposalStatus?(id: string): SessionDisposalStatus
  reserveSessionsForDeletion?(ids: readonly string[]): Promise<BlockersResult>
  releaseSessionDeletionReservation?(token: string): void
  /** L1: abort the agent's active phase; keepInbox mirrors the official cancel option. */
  stop?(id: string, keepInbox: boolean): void
  /** Observe one live agent without mutating anything. */
  peek?(id: string): AgentPeek
  /** L2: force the published phase back to idle (the machine stays alive). */
  phaseReset?(id: string): void
  /** Materialize a persisted session back into a live agent. */
  resumeSession?(id: string): Promise<void>
}

export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
}

export interface HostWorkspaceRegistry {
  list(): WorkspaceLike[]
  get(id: string): WorkspaceLike | undefined
  readonly archivedSessionIds: readonly string[]
  archiveSession(sessionId: string): Promise<void>
  forgetSession?(sessionId: string): Promise<void>
  unarchiveSession?(sessionId: string): Promise<void>
}

export interface PersistenceSnapshotLike {
  header: SessionMetaLike
  revision?: unknown
}

export interface InspectionLike {
  meta: SessionMetaLike
  events?: readonly unknown[]
}

export interface LocationLike {
  kind: string
  path: string
}

/**
 * Narrow persistence contract. Host 0.1.5 renamed the seam (`listSnapshots()`
 * to `list()`, `inspect()` to `stat()`, returning `{ header }` instead of
 * `{ meta }`); adaptHostServices translates both directions at the host
 * boundary, so this stable internal surface keeps archive/delete logic and the
 * capability probe reading the same names.
 */
export interface HostSessionPersistence {
  listSnapshots?(signal?: AbortSignal): Promise<PersistenceSnapshotLike[]>
  inspect?(id: string, signal?: AbortSignal): Promise<InspectionLike>
  locate?(meta: SessionMetaLike): LocationLike | undefined
}

export interface HostProjections {
  snapshot?(session: LiveSessionLike): ProjectionSnapshotLike
}

export interface HostProjectionCache {
  coldSnapshot?(id: string, signal?: AbortSignal): Promise<ProjectionSnapshotLike>
  cachedSnapshot?(meta: SessionMetaLike): ProjectionSnapshotLike | undefined
}

export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

/** Everything the host service layer consumes. */
export interface HostServices {
  agents: HostAgents | undefined
  workspaces: HostWorkspaceRegistry | undefined
  persistence: HostSessionPersistence | undefined
  projections: HostProjections | undefined
  projectionCache: HostProjectionCache | undefined
  webServer: WebServerLike | undefined
}

// ---------------------------------------------------------------------------
// Journal / persistence of plugin state
// ---------------------------------------------------------------------------

export interface StagedEntry {
  id: string
  /** Session-owned directory path before staging (absolute). */
  original: string
  /** Unique same-directory trash name (absolute), e.g. `.dsh-manage-sessions-trash-*`. */
  staged: string
  /** The directory existed on disk and the staging renames were attempted. */
  preexisting: boolean
  /** Exact backend-owned JSONL artifact path before staging. */
  artifactOriginal: string
  /** Non-discoverable basename used while the directory is staged. */
  artifactHiddenName: string
}

export type JournalPhase = 'staging' | 'staged' | 'committing' | 'committed'

export interface DeleteJournal {
  version: 1
  txnId: string
  /** Process-local deletion lease token; absent on journals from pre-lease builds. */
  reservationToken?: string
  ids: string[]
  entries: StagedEntry[]
  phase: JournalPhase
  startedAt: string
}

export interface RecoveryReport {
  found: boolean
  action: 'none' | 'restored' | 'finished-cleanup' | 'forwarded-commit' | 'deferred'
  restored: string[]
  cleaned: string[]
  deferred: string[]
  warnings: string[]
}
