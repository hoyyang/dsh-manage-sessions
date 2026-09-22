/**
 * Shared fixtures for dsh-manage-sessions tests. Mocks satisfy the narrow
 * HostServices structural contracts; every test uses temp dirs only and never
 * touches real ~/.dsh data.
 */
import { mkdtemp, mkdir, writeFile, rename as fsRename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathExists, removeTrashDir } from '../src/state.ts'
import type { SessionManagerFileOps } from '../src/session-service.ts'
import type {
  BlockersResult,
  ContextBreakdownView,
  ContextPressureView,
  HostAgents,
  HostProjectionCache,
  HostProjections,
  HostServices,
  HostSessionPersistence,
  HostWorkspaceRegistry,
  InspectionLike,
  LiveAgentLike,
  LiveSessionLike,
  LocationLike,
  PersistenceSnapshotLike,
  ProjectionSnapshotLike,
  SessionMetaLike,
  SessionStatsView,
  TokenUsageView,
  WorkspaceLike,
} from '../src/types.ts'

export interface CallRec {
  op: string
  id?: string
  args?: unknown[]
}

/** Compact call log: `op` alone, or `op:id` when an id was recorded. */
export function ops(calls: CallRec[]): string[] {
  return calls.map((call) => (call.id === undefined ? call.op : `${call.op}:${call.id}`))
}

export async function mkTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsm-test-'))
}

export function fullStats(): SessionStatsView {
  return { turns: 3, steps: 5, llmMs: 100, toolMs: 50, ttftMs: 20, ttftSteps: 2, decodeMs: 40, decodeTokens: 120 }
}

export function fullTokens(): TokenUsageView {
  return { uncachedInputTokens: 300, outputTokens: 150, cacheReadTokens: 80, cacheWriteTokens: 40 }
}

export function fullBreakdown(): ContextBreakdownView {
  return { systemTokens: 30, toolsTokens: 20, messageTokens: 100 }
}

export function pressure(): ContextPressureView {
  return { pressureTokens: 900, projectedTokens: 1200, contextWindow: 128000 }
}

/**
 * Create a real JSONL artifact at `<root>/project/<id>/session.jsonl` plus any
 * extra files (e.g. attachments). The id must be alphanumeric so the backend
 * `encodeSegment(id)` equals the directory name.
 */
export async function writeSessionDir(root: string, id: string, extraFiles: string[] = []): Promise<string> {
  const dir = join(root, 'project', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl'), `{"type":"session","id":"${id}"}\n`, 'utf8')
  for (const relative of extraFiles) {
    await mkdir(dirname(join(dir, relative)), { recursive: true })
    await writeFile(join(dir, relative), 'attachment', 'utf8')
  }
  return dir
}

export interface HostOptions {
  calls: CallRec[]
  root?: string
  liveAgents?: LiveAgentLike[]
  snapshots?: PersistenceSnapshotLike[]
  workspaces?: WorkspaceLike[]
  archivedSessionIds?: string[]
  disposal?: (ids: readonly string[]) => Promise<BlockersResult>
  archive?: (id: string) => Promise<void>
  unarchive?: (id: string) => Promise<void>
  forget?: (id: string) => Promise<void>
  inspectImpl?: (id: string) => Promise<InspectionLike>
  locateImpl?: (meta: SessionMetaLike) => LocationLike | undefined
  liveSnapshot?: (session: LiveSessionLike) => ProjectionSnapshotLike
  coldSnapshot?: (id: string) => Promise<ProjectionSnapshotLike>
  cachedSnapshot?: (meta: SessionMetaLike) => ProjectionSnapshotLike | undefined
}

/**
 * Full contract mock. Every host call is recorded into `opts.calls` so tests
 * can assert exact call order. Defaults are the rc.8-shaped happy paths.
 */
export function makeHost(opts: HostOptions): HostServices {
  const calls = opts.calls
  const root = opts.root ?? ''
  const snapshots = opts.snapshots ?? []
  const liveAgents = opts.liveAgents ?? []
  const registry = opts.workspaces ?? []

  const agents: HostAgents = {
    list: () => liveAgents,
    get: (id) => liveAgents.find((agent) => agent.id === id),
    sessionDisposalStatus: (id) => {
      const live = liveAgents.find((agent) => agent.id === id)
      return live ? (live.status === 'running' ? 'running' : 'idle') : 'cold'
    },
    reserveSessionsForDeletion: async (ids) => {
      calls.push({ op: 'reserve', args: [[...ids]] })
      return opts.disposal ? await opts.disposal(ids) : { ok: true, reservationToken: 'test-reservation', disposedIds: [...ids] }
    },
    releaseSessionDeletionReservation: (token) => {
      calls.push({ op: 'release', id: token })
    },
  }

  const workspaces: HostWorkspaceRegistry = {
    list: () => registry,
    get: (id) => registry.find((workspace) => workspace.id === id),
    archivedSessionIds: opts.archivedSessionIds ?? [],
    archiveSession: async (id) => {
      calls.push({ op: 'archive', id })
      if (opts.archive) await opts.archive(id)
    },
    forgetSession: async (id) => {
      calls.push({ op: 'forget', id })
      if (opts.forget) await opts.forget(id)
    },
  }
  if (opts.unarchive) {
    const unarchive = opts.unarchive
    workspaces.unarchiveSession = async (id) => {
      calls.push({ op: 'unarchive', id })
      await unarchive(id)
    }
  }

  const persistence: HostSessionPersistence = {
    listSnapshots: async () => snapshots,
    inspect: async (id) => {
      calls.push({ op: 'inspect', id })
      if (opts.inspectImpl) return await opts.inspectImpl(id)
      return { meta: { id, createdAt: 1000 } }
    },
    locate: (meta) => {
      const id = String(meta.id)
      calls.push({ op: 'locate', id })
      if (opts.locateImpl) return opts.locateImpl(meta)
      return { kind: 'jsonl', path: join(root, 'project', id, 'session.jsonl') }
    },
  }

  const projections: HostProjections = {
    snapshot: (session) => {
      calls.push({ op: 'liveSnapshot', id: session.id })
      return opts.liveSnapshot ? opts.liveSnapshot(session) : { asOfSeq: 0, values: {} }
    },
  }

  const projectionCache: HostProjectionCache = {
    cachedSnapshot: (meta) => {
      const id = String(meta.id)
      calls.push({ op: 'cachedSnapshot', id })
      return opts.cachedSnapshot?.(meta)
    },
    coldSnapshot: async (id) => {
      calls.push({ op: 'coldSnapshot', id })
      return opts.coldSnapshot ? await opts.coldSnapshot(id) : { asOfSeq: 0, values: {} }
    },
  }

  return { agents, workspaces, persistence, projections, projectionCache, webServer: undefined }
}

export interface FileOpsOptions {
  /** 1-based index of the rename call that throws `rename-boom`. */
  failRenameAt?: number
  /** Every removeTrash call throws `remove-boom`. */
  failRemoveTrash?: boolean
}

/**
 * File ops that delegate to real fs (so staged dirs really move) while
 * recording every call for order assertions.
 */
export function recordingFileOps(calls: CallRec[], options: FileOpsOptions = {}): SessionManagerFileOps {
  let renames = 0
  return {
    exists: async (path) => {
      calls.push({ op: 'exists', id: basename(path) })
      return await pathExists(path)
    },
    rename: async (from, to) => {
      calls.push({ op: 'rename', id: basename(from), args: [from, to] })
      renames += 1
      if (options.failRenameAt === renames) throw new Error('rename-boom')
      await fsRename(from, to)
    },
    removeTrash: async (path) => {
      calls.push({ op: 'rm', id: basename(path), args: [path] })
      if (options.failRemoveTrash) throw new Error('remove-boom')
      await removeTrashDir(path)
    },
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
