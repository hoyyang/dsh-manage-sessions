import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { makeHost, mkTmp } from './helpers.ts'
import type { CallRec } from './helpers.ts'
import { missingForCapability, probeCapabilities } from '../src/capabilities.ts'
import { SessionManagerService } from '../src/session-service.ts'
import { PluginStateStore } from '../src/state.ts'
import type { HostServices } from '../src/types.ts'

test('probeCapabilities fails closed on an empty host', () => {
  const caps = probeCapabilities({} as HostServices, true)
  assert.deepEqual(caps, {
    catalog: false,
    disposalStatus: false,
    disposeBatch: false,
    archive: false,
    archiveBatch: false,
    unarchiveAvailable: false,
    delete: false,
    stateReady: true,
    projectionsLive: false,
    projectionsCold: false,
    forceStop: false,
    forceStopResume: false,
  })
})

test('probeCapabilities is positive only for actually-present contracts', () => {
  const calls: CallRec[] = []
  const base = makeHost({ calls })
  const caps = probeCapabilities(base, true)
  assert.equal(caps.catalog, true)
  assert.equal(caps.disposalStatus, true)
  assert.equal(caps.disposeBatch, true)
  assert.equal(caps.archive, true)
  assert.equal(caps.archiveBatch, false) // no unarchive compensation
  assert.equal(caps.unarchiveAvailable, false)
  assert.equal(caps.delete, true)
  assert.equal(caps.projectionsLive, true)
  assert.equal(caps.projectionsCold, true)

  const compensated = makeHost({ calls, unarchive: async () => {} })
  const compensatedCaps = probeCapabilities(compensated, true)
  assert.equal(compensatedCaps.archiveBatch, true)
  assert.equal(compensatedCaps.unarchiveAvailable, true)

  const brokenStateCaps = probeCapabilities(compensated, false)
  assert.equal(brokenStateCaps.unarchiveAvailable, false)
})

test('missingForCapability names the exact missing methods', () => {
  assert.deepEqual(missingForCapability({} as HostServices, 'delete'), [
    'ctx.workspaceRegistry',
    'ctx.agents',
    'ctx.sessionPersistence',
  ])
  const partial = {
    agents: { list: () => [] },
    workspaces: { list: () => [], archivedSessionIds: [] },
    persistence: { listSnapshots: async () => [] },
  } as unknown as HostServices
  assert.deepEqual(missingForCapability(partial, 'delete'), [
    'ctx.agents.sessionDisposalStatus (core patch)',
    'ctx.agents.reserveSessionsForDeletion (core patch)',
    'ctx.agents.releaseSessionDeletionReservation (core patch)',
    'ctx.workspaceRegistry.forgetSession (core patch)',
    'ctx.sessionPersistence.inspect',
    'ctx.sessionPersistence.locate',
  ])
  assert.deepEqual(missingForCapability(partial, 'archive'), ['ctx.workspaceRegistry.archiveSession'])
})

test('delete and archive fail closed when the contract chain is incomplete', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const services = {
    agents: { list: () => [] },
    workspaces: { list: () => [], archivedSessionIds: [] },
    persistence: { listSnapshots: async () => [] },
  } as unknown as HostServices
  const svc = new SessionManagerService(services, state)
  assert.equal(svc.capabilities.catalog, true) // read path still works
  assert.equal(svc.capabilities.delete, false)
  assert.equal(svc.capabilities.archive, false)

  const del = await svc.delete(['s1'])
  assert.equal(del.ok, false)
  if (!del.ok) {
    assert.equal(del.error.code, 'capability-missing')
    assert.deepEqual(del.error.details?.missing, [
      'ctx.agents.sessionDisposalStatus (core patch)',
      'ctx.agents.reserveSessionsForDeletion (core patch)',
    'ctx.agents.releaseSessionDeletionReservation (core patch)',
      'ctx.workspaceRegistry.forgetSession (core patch)',
      'ctx.sessionPersistence.inspect',
      'ctx.sessionPersistence.locate',
    ])
  }

  const arch = await svc.archive(['s1'])
  assert.equal(arch.ok, false)
  if (!arch.ok) {
    assert.equal(arch.error.code, 'capability-missing')
    assert.deepEqual(arch.error.details?.missing, ['ctx.workspaceRegistry.archiveSession'])
  }
  assert.equal(await state.readJournal(), null)
})

test('corrupt archive-times state is preserved and all mutations fail closed', async () => {
  const root = await mkTmp()
  const stateDir = join(root, 'state')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(stateDir, { recursive: true }))
  const corrupt = '{ definitely-not-json\n'
  await writeFile(join(stateDir, 'archive-times.json'), corrupt, 'utf8')
  const state = await PluginStateStore.open(stateDir)
  const calls: CallRec[] = []
  const svc = new SessionManagerService(makeHost({
    calls,
    snapshots: [{ header: { id: 's1' } }],
    archivedSessionIds: ['s1'],
  }), state)

  assert.equal(state.isReady(), false)
  assert.match(state.stateError() ?? '', /cannot parse/)
  assert.equal(svc.capabilities.catalog, true)
  assert.equal(svc.capabilities.archive, false)
  assert.equal(svc.capabilities.delete, false)
  const catalog = await svc.catalog()
  assert.equal(catalog.ok, true)
  assert.equal(catalog.archivedSessions[0]?.id, 's1')
  assert.equal(catalog.archivedSessions[0]?.archiveTime, null)
  assert.equal((await svc.archive(['s1'])).ok, false)
  assert.equal((await svc.delete(['s1'])).ok, false)
  assert.deepEqual(calls.filter((call) => ['archive', 'reserve', 'inspect', 'locate', 'forget'].includes(call.op)), [])
  assert.equal(await readFile(join(stateDir, 'archive-times.json'), 'utf8'), corrupt)
})
