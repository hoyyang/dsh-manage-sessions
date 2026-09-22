/**
 * Plugin-owned durable state under `$DSH_HOME/dsh-manage-sessions` (tests use
 * temp roots only — never the real `~/.dsh`):
 *
 * - `archive-times.json`  plugin-owned archive instants {id -> ISO-8601}.
 *                          Legacy archives (archived by the official surface
 *                          before this plugin existed) have NO entry; the
 *                          catalog renders those as `archiveTime: null`.
 *                          One record per mutation batch, written atomically
 *                          (temp file + fsync + rename + directory fsync).
 * - `journal.json`        the delete transaction journal (staging record +
 *                          phase), also written atomically. Startup recovery
 *                          reconciles: uncommitted -> restore original names;
 *                          committed -> finish trash cleanup.
 *
 * All mutations are serialized in-process by {@link Mutex}; archive-times and
 * journal writes additionally go through the atomic writer.
 */
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateSessionArtifactPath } from './encode.ts'
import type { DeleteJournal, StagedEntry } from './types.ts'

export const ARCHIVE_TIMES_FILE = 'archive-times.json'
export const JOURNAL_FILE = 'journal.json'
export const TRASH_PREFIX = '.dsh-manage-sessions-trash-'

interface ArchiveTimesPayload {
  version: 1
  times: Record<string, string>
}

const EMPTY_PAYLOAD: ArchiveTimesPayload = { version: 1, times: {} }

/** Serialize mutations within the process (one exclusive queue). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/**
 * Same-directory unique trash path for a staged session-owned directory.
 * The trash name is a sibling of the original (same-directory rename), keeps
 * the encoded id prefix for human forensics, and is unique per transaction.
 */
export function trashPathFor(original: string, txnId: string): string {
  const base = basenameOf(original)
  const suffix = base.length > 64 ? base.slice(0, 64) : base
  return join(dirname(original), `${TRASH_PREFIX}${suffix}-${txnId}`)
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const back = path.lastIndexOf('\\')
  return path.slice(Math.max(slash, back) + 1)
}

export function isTrashPath(path: string): boolean {
  return basenameOf(path).startsWith(TRASH_PREFIX)
}

export class PluginStateStore {
  readonly dir: string
  private times: Record<string, string> = {}
  private ready = false
  private loadError: string | null = null

  private constructor(dir: string) {
    this.dir = dir
  }

  static async open(dir: string): Promise<PluginStateStore> {
    await mkdir(dir, { recursive: true })
    const store = new PluginStateStore(dir)
    await store.reloadArchiveTimes()
    return store
  }

  isReady(): boolean {
    return this.ready
  }

  stateError(): string | null {
    return this.loadError
  }

  archiveTimes(): Readonly<Record<string, string>> {
    return this.times
  }

  archiveTimeOf(id: string): string | null {
    return this.times[id] ?? null
  }

  private async reloadArchiveTimes(): Promise<void> {
    const path = join(this.dir, ARCHIVE_TIMES_FILE)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.times = {}
        this.ready = true
        this.loadError = null
        return
      }
      this.ready = false
      this.loadError = `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`
      return
    }
    try {
      const parsed = JSON.parse(text) as Partial<ArchiveTimesPayload>
      if (!parsed || parsed.version !== 1 || !parsed.times || typeof parsed.times !== 'object' || Array.isArray(parsed.times)) {
        throw new Error('unsupported or invalid archive-times payload')
      }
      for (const [id, value] of Object.entries(parsed.times)) {
        if (id.length === 0 || typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
          throw new Error(`invalid archive timestamp for ${JSON.stringify(id)}`)
        }
      }
      this.times = { ...parsed.times }
      this.ready = true
      this.loadError = null
    } catch (error) {
      // Preserve the corrupt source verbatim and fail mutations closed. Catalog
      // remains available with legacy-null timestamps until the file is repaired.
      this.times = {}
      this.ready = false
      this.loadError = `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** Atomic write of the full archive-times map. Only resolves after durability. */
  async writeArchiveTimes(times: Record<string, string>): Promise<void> {
    await atomicWriteJson(this.dir, ARCHIVE_TIMES_FILE, { version: 1, times } satisfies ArchiveTimesPayload)
    this.times = { ...times }
  }

  /** Idempotent removal of a set of ids from archive-times (recovery forward-commit). */
  async removeArchiveTimesFor(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    let changed = false
    const preserved: Record<string, string> = {}
    for (const [id, time] of Object.entries(this.times)) {
      if (ids.includes(id)) changed = true
      else preserved[id] = time
    }
    if (!changed) return
    await this.writeArchiveTimes(preserved)
  }

  async writeJournal(journal: DeleteJournal): Promise<void> {
    await atomicWriteJson(this.dir, JOURNAL_FILE, journal)
  }

  async readJournal(): Promise<DeleteJournal | null> {
    const path = join(this.dir, JOURNAL_FILE)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(`cannot read pending delete journal ${path}`, { cause: error })
    }
    try {
      const parsed = JSON.parse(text) as Partial<DeleteJournal>
      if (!parsed || parsed.version !== 1 || typeof parsed.txnId !== 'string' || !/^[A-Za-z0-9-]+$/.test(parsed.txnId) || (parsed.reservationToken !== undefined && (typeof parsed.reservationToken !== 'string' || !/^[A-Za-z0-9-]+$/.test(parsed.reservationToken))) || !Array.isArray(parsed.entries) || !Array.isArray(parsed.ids) || !['staging', 'staged', 'committing', 'committed'].includes(String(parsed.phase))) {
        throw new Error('invalid journal payload')
      }
      if (!parsed.ids.every((id): id is string => typeof id === 'string' && id.length > 0) || new Set(parsed.ids).size !== parsed.ids.length) {
        throw new Error('invalid journal ids')
      }
      const entryIds = new Set<string>()
      for (const entry of parsed.entries) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.original !== 'string' || typeof entry.staged !== 'string' || typeof entry.preexisting !== 'boolean' || typeof entry.artifactOriginal !== 'string' || typeof entry.artifactHiddenName !== 'string') {
          throw new Error('invalid journal entry')
        }
        if (!isAbsolute(entry.original) || !isAbsolute(entry.staged) || !isAbsolute(entry.artifactOriginal)) throw new Error('journal paths must be absolute')
        if (entry.staged !== trashPathFor(entry.original, parsed.txnId)) throw new Error('journal trash path is not transaction-owned')
        if (dirname(entry.artifactOriginal) !== entry.original || !['session.jsonl', 'session.jsonl.zstd'].includes(basename(entry.artifactOriginal))) {
          throw new Error('journal artifact path is not owned by the session directory')
        }
        const checked = validateSessionArtifactPath(entry.artifactOriginal, entry.id)
        if (!checked.ok || checked.dir !== entry.original) throw new Error('journal session identity/path mismatch')
        if (!/^\.dsh-manage-sessions-artifact-[A-Za-z0-9-]+$/.test(entry.artifactHiddenName) || entry.artifactHiddenName.includes('/') || entry.artifactHiddenName.includes('\\')) {
          throw new Error('invalid hidden artifact basename')
        }
        if (entryIds.has(entry.id)) throw new Error('duplicate journal entry id')
        entryIds.add(entry.id)
      }
      if (entryIds.size !== parsed.ids.length || parsed.ids.some((id) => !entryIds.has(id))) throw new Error('journal entries do not match ids')
      return parsed as DeleteJournal
    } catch (error) {
      throw new Error(`cannot parse pending delete journal ${path}`, { cause: error })
    }
  }

  async clearJournal(): Promise<void> {
    try {
      await unlink(join(this.dir, JOURNAL_FILE))
      await fsyncDir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/** Recursive delete of one staged trash path (best-effort cleanup primitive). */
export async function removeTrashDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/** Rename-origin restore primitive used by rollback and recovery. */
export async function renameBack(staged: string, original: string): Promise<void> {
  await rename(staged, original)
}

export async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Atomic JSON write: unique temp file in the same directory, fsync file,
 * rename over the target, then fsync the directory (POSIX; best-effort).
 */
async function atomicWriteJson(dir: string, filename: string, value: unknown): Promise<void> {
  const target = join(dir, filename)
  const tmp = join(dir, `.${filename}.tmp-${process.pid}-${randomUUID()}`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  try {
    const handle = await open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, target)
    await fsyncDir(dir)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {}
    try {
      await fsyncDir(dir)
    } catch {}
    throw error
  }
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is best-effort (some platforms/filesystems refuse it).
  }
}

export { EMPTY_PAYLOAD }
export type { ArchiveTimesPayload }
