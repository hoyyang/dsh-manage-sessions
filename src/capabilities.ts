/**
 * Runtime capability probe over the core-contract chain.
 *
 * Every destructive capability is derived from the ACTUAL presence of the
 * patched/contracted methods, never from package versions. When a required
 * method is missing, the catalog keeps working while archive/delete flip to
 * false and their routes fail closed with a clear compatibility error.
 */
import type { HostCapabilities, HostServices } from './types.ts'

export function probeCapabilities(services: HostServices, stateReady: boolean): HostCapabilities {
  const agents = services.agents
  const workspaces = services.workspaces
  const persistence = services.persistence
  const projections = services.projections
  const cache = services.projectionCache

  const has = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'

  const forceStopSurface = Boolean(agents) && has(agents?.stop) && has(agents?.peek) && has(agents?.phaseReset)

  const disposalStatus = has(agents?.sessionDisposalStatus)
  const disposeBatch = has(agents?.reserveSessionsForDeletion) && has(agents?.releaseSessionDeletionReservation)
  const archiveOfficial = has(workspaces?.archiveSession)
  const forgetOfficial = has(workspaces?.forgetSession)
  const unarchiveOfficial = has(workspaces?.unarchiveSession)
  const inspectAvailable = has(persistence?.inspect)
  const locateAvailable = has(persistence?.locate)
  const listSnapshotsAvailable = has(persistence?.listSnapshots)

  const catalog = Boolean(workspaces && has(workspaces.list) && persistence && listSnapshotsAvailable && agents && has(agents.list))
  const deleteReady =
    disposalStatus &&
    disposeBatch &&
    forgetOfficial &&
    inspectAvailable &&
    locateAvailable &&
    listSnapshotsAvailable &&
    stateReady

  return {
    catalog,
    disposalStatus,
    disposeBatch,
    // Archive/unarchive/delete all preflight their ids through `knownIds()`,
    // which reads the persistence catalogue. Without it the route used to pass
    // the capability gate and then fail per call ("listSnapshots is not a
    // function"), so the catalogue read is part of every mutation capability.
    archive: archiveOfficial && listSnapshotsAvailable && Boolean(workspaces) && stateReady,
    // A multi-id batch whose k-th member fails needs unarchive compensation to
    // roll earlier archives back; runtime presence stays authoritative for both
    // methods (never a version guess).
    archiveBatch: archiveOfficial && unarchiveOfficial && listSnapshotsAvailable,
    unarchiveAvailable: unarchiveOfficial && listSnapshotsAvailable && Boolean(workspaces) && stateReady,
    delete: deleteReady,
    stateReady,
    projectionsLive: has(projections?.snapshot),
    // A coldSnapshot capability may exist, but manager catalog reads are
    // deliberately cache-only to avoid unbounded log folding.
    projectionsCold: has(cache?.cachedSnapshot),
    forceStop: forceStopSurface,
    forceStopResume: forceStopSurface && has(agents?.resumeSession),
  }
}

/** Human-readable missing-method description for fail-closed error bodies. */
export function missingForCapability(services: HostServices, capability: 'archive' | 'delete' | 'forceStop'): string[] {
  const missing: string[] = []
  const agents = services.agents
  const workspaces = services.workspaces
  const persistence = services.persistence
  const has = (value: unknown) => typeof value === 'function'
  if (capability === 'archive') {
    if (!workspaces) missing.push('ctx.workspaceRegistry')
    else if (!has(workspaces.archiveSession)) missing.push('ctx.workspaceRegistry.archiveSession')
  } else if (capability === 'delete') {
    if (!workspaces) missing.push('ctx.workspaceRegistry')
    if (!agents) missing.push('ctx.agents')
    else {
      if (!has(agents.sessionDisposalStatus)) missing.push('ctx.agents.sessionDisposalStatus (core patch)')
      if (!has(agents.reserveSessionsForDeletion)) missing.push('ctx.agents.reserveSessionsForDeletion (core patch)')
      if (!has(agents.releaseSessionDeletionReservation)) missing.push('ctx.agents.releaseSessionDeletionReservation (core patch)')
    }
    if (workspaces && !has(workspaces.forgetSession)) missing.push('ctx.workspaceRegistry.forgetSession (core patch)')
    if (!persistence) missing.push('ctx.sessionPersistence')
    else {
      if (!has(persistence.inspect)) missing.push('ctx.sessionPersistence.inspect')
      if (!has(persistence.locate)) missing.push('ctx.sessionPersistence.locate')
      if (!has(persistence.listSnapshots)) missing.push('ctx.sessionPersistence.listSnapshots')
    }
  } else if (capability === 'forceStop') {
    if (!agents) missing.push('ctx.agents')
    else if (!has(agents.resumeSession)) missing.push('ctx.agents.resume (auto-resume)')
  }
  return missing
}
