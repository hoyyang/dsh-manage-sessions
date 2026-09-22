/**
 * Startup reconciliation for plugin state, run once before mutation routes
 * serve. Phase model (crash-window-honest):
 *
 * - `staging` / `staged`: no official metadata mutation has happened yet —
 *   recovery restores every staged directory's original name, then clears the
 *   journal. This is a truthful un-commit.
 * - `committing`: written durably BEFORE the first official forget. Some (or
 *   all) forgets may be done; official forgets are idempotent and cannot be
 *   undone, so recovery FORWARD-COMMITS: it re-runs `forgetSession` for every
 *   transaction id (needs the workspace registry), then atomically removes
 *   archive timestamps (the metadata commit), then finishes trash cleanup.
 *   A crash between individual forgets therefore cannot restore logs whose
 *   metadata is partially forgotten.
 * - `committed`: metadata commit is done; recovery only finishes best-effort
 *   trash cleanup and clears the journal.
 *
 * A restore whose original name has been re-created (a new session under the
 * same id) is never overwritten: the staged data is preserved under a
 * collision name and reported for manual review.
 */
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isTrashPath, pathExists, PluginStateStore, removeTrashDir } from './state.ts'
import type { DeleteJournal, HostWorkspaceRegistry, RecoveryReport } from './types.ts'

export interface RecoveryLogger {
  info?(message: string): void
  warn?(message: string): void
}

export interface RecoveryOptions {
  /** Required to forward-commit a `committing` journal (finish official forgets). */
  workspaces?: HostWorkspaceRegistry
  /** Releases a surviving same-process deletion lease after safe recovery. */
  releaseReservation?(token: string): void
}

export async function recoverState(
  state: PluginStateStore,
  options: RecoveryOptions = {},
  logger?: RecoveryLogger,
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    found: false,
    action: 'none',
    restored: [],
    cleaned: [],
    deferred: [],
    warnings: [],
  }
  let journal: DeleteJournal | null
  try {
    journal = await state.readJournal()
  } catch (error) {
    report.found = true
    report.action = 'deferred'
    report.deferred.push(journalPathOf(state))
    report.warnings.push(`pending delete journal is unreadable and was preserved: ${errorMessage(error)}`)
    logger?.warn?.(`[dsh-manage-sessions] recovery: unreadable journal: ${errorMessage(error)}`)
    return report
  }
  if (!journal) return report
  report.found = true
  logger?.info?.(`[dsh-manage-sessions] recovery: journal ${journal.txnId} phase=${journal.phase}`)

  if (journal.phase === 'staging' || journal.phase === 'staged') {
    report.action = 'restored'
    await restoreStaged(state, journal, report, logger)
    if (report.deferred.length > 0) {
      // Keep the journal so the next startup retries the restore.
      report.action = 'deferred'
      return report
    }
    await clearJournalSafe(state, report, logger)
    releaseReservation(journal, options)
    return report
  }

  if (journal.phase === 'committing') {
    // Official metadata may already be irreversibly forgotten for some ids:
    // forward the commit — finish every forget idempotently, then metadata.
    report.action = 'forwarded-commit'
    const workspaces = options.workspaces
    if (!workspaces || typeof workspaces.forgetSession !== 'function') {
      report.deferred.push(`committing journal ${journal.txnId}: workspace registry unavailable`)
      report.warnings.push('workspace registry unavailable: cannot finish official forgets; journal kept for the next startup')
      return report
    }
    for (const id of journal.ids) {
      try {
        await workspaces.forgetSession(id)
      } catch (error) {
        report.deferred.push(id)
        report.warnings.push(`official forget failed for ${id}: ${errorMessage(error)}`)
      }
    }
    if (report.deferred.length > 0) return report // journal stays; retry next startup
    try {
      await state.removeArchiveTimesFor(journal.ids)
    } catch (error) {
      report.warnings.push(`archive-times removal failed: ${errorMessage(error)}`)
      return report
    }
    await cleanupTrash(journal, report, logger)
    if (report.deferred.length > 0) return report
    await clearJournalSafe(state, report, logger)
    releaseReservation(journal, options)
    return report
  }

  if (journal.phase === 'committed') {
    report.action = 'finished-cleanup'
    await cleanupTrash(journal, report, logger)
    if (report.deferred.length > 0) return report
    await clearJournalSafe(state, report, logger)
    releaseReservation(journal, options)
    return report
  }

  report.warnings.push(`unknown journal phase ${String(journal.phase)}; left in place`)
  report.action = 'deferred'
  return report
}

/** Restore both staging renames: directory first, then the hidden artifact name. */
async function restoreStaged(state: PluginStateStore, journal: DeleteJournal, report: RecoveryReport, logger?: RecoveryLogger): Promise<void> {
  let quarantineIndex = 0
  for (const entry of journal.entries) {
    if (!entry.preexisting || !isTrashPath(entry.staged)) continue
    try {
      const stagedExists = await pathExists(entry.staged)
      const originalExists = await pathExists(entry.original)
      if (stagedExists && originalExists) {
        // A new session reused the original path. Never overwrite it and never
        // leave the old staged directory under the JSONL persistence tree.
        const quarantine = join(state.dir, `quarantine-${journal.txnId}-${quarantineIndex++}`)
        await rename(entry.staged, quarantine)
        report.warnings.push(`original re-created for ${entry.id}; old staged data preserved outside persistence at ${quarantine}`)
        continue
      }
      if (stagedExists && !originalExists) {
        await rename(entry.staged, entry.original)
        report.restored.push(entry.id)
      }
      if (await pathExists(entry.original)) {
        const hidden = join(entry.original, entry.artifactHiddenName)
        if (await pathExists(hidden)) {
          if (await pathExists(entry.artifactOriginal)) {
            const quarantine = join(state.dir, `quarantine-artifact-${journal.txnId}-${quarantineIndex++}`)
            await rename(hidden, quarantine)
            report.warnings.push(`artifact path re-created for ${entry.id}; hidden artifact preserved at ${quarantine}`)
          } else {
            await rename(hidden, entry.artifactOriginal)
          }
        }
      }
    } catch (error) {
      report.deferred.push(entry.staged)
      report.warnings.push(`could not restore ${entry.id}: ${errorMessage(error)}`)
    }
  }
  logger?.info?.(`[dsh-manage-sessions] recovery: restored ${report.restored.length} session directories`)
}


/** Best-effort removal of every staged trash directory. */
async function cleanupTrash(journal: DeleteJournal, report: RecoveryReport, logger?: RecoveryLogger): Promise<void> {
  for (const entry of journal.entries) {
    if (!entry.preexisting || !isTrashPath(entry.staged)) continue
    if (!(await pathExists(entry.staged))) continue
    try {
      await removeTrashDir(entry.staged)
      report.cleaned.push(entry.id)
    } catch (error) {
      report.deferred.push(entry.staged)
      report.warnings.push(`trash cleanup failed for ${entry.id}: ${errorMessage(error)}`)
    }
  }
  logger?.info?.(`[dsh-manage-sessions] recovery: cleaned ${report.cleaned.length} trash directories`)
}

async function clearJournalSafe(state: PluginStateStore, report: RecoveryReport, logger?: RecoveryLogger): Promise<void> {
  try {
    await state.clearJournal()
  } catch (error) {
    // Journal remains; every phase handler above is idempotent on re-entry.
    report.warnings.push(`journal could not be cleared: ${errorMessage(error)}`)
    logger?.warn?.(`[dsh-manage-sessions] recovery: journal clear failed: ${errorMessage(error)}`)
  }
}

export function journalPathOf(state: PluginStateStore): string {
  return join(state.dir, 'journal.json')
}

function releaseReservation(journal: DeleteJournal, options: RecoveryOptions): void {
  if (journal.reservationToken === undefined) return
  options.releaseReservation?.(journal.reservationToken)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
