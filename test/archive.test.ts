import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeHost, mkTmp, ops } from './helpers.ts'
import type { CallRec } from './helpers.ts'
import { SessionManagerService } from '../src/session-service.ts'
import { PluginStateStore } from '../src/state.ts'

test('multi-id archive fails closed without unarchive compensation', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    snapshots: [{ header: { id: 'a' } }, { header: { id: 'b' } }],
  })
  const svc = new SessionManagerService(services, state)
  assert.equal(svc.capabilities.archive, true)
  assert.equal(svc.capabilities.archiveBatch, false) // rc.8: no unarchiveSession

  const result = await svc.archive(['a', 'b'])
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'capability-missing')
    assert.deepEqual(result.error.details?.missing, ['ctx.workspaceRegistry.unarchiveSession'])
  }
  assert.deepEqual(ops(calls), []) // nothing archived before the fail-close
  assert.deepEqual(state.archiveTimes(), {})
})

test('partial multi-id archive is compensated via unarchive in reverse order', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    snapshots: [{ header: { id: 'a' } }, { header: { id: 'b' } }],
    archive: async (id) => {
      if (id === 'b') throw new Error('boom')
    },
    unarchive: async () => {},
  })
  const svc = new SessionManagerService(services, state)
  assert.equal(svc.capabilities.archiveBatch, true)
  assert.equal(svc.capabilities.unarchiveAvailable, true)

  const result = await svc.archive(['a', 'b'])
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'archive-partial')
    assert.deepEqual(result.error.details?.cause, 'boom')
    assert.deepEqual(result.error.details?.archivedBeforeFailure, ['a'])
    assert.deepEqual(result.error.details?.rollbackErrors, [])
  }
  assert.deepEqual(ops(calls), ['archive:a', 'archive:b', 'unarchive:a'])
  assert.deepEqual(state.archiveTimes(), {}) // no timestamp commit after rollback
})

test('single archive commits a timestamp and leaves already-archived ids alone', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    snapshots: [{ header: { id: 'a' } }, { header: { id: 'x' } }],
    archivedSessionIds: ['x'],
  })
  const svc = new SessionManagerService(services, state)

  const result = await svc.archive(['a', 'x'])
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.archivedIds, ['a'])
    assert.deepEqual(result.alreadyArchivedIds, ['x'])
    assert.equal(typeof result.archiveTimes.a, 'string')
    assert.equal(result.archiveTimes.x, undefined)
    assert.equal(state.archiveTimeOf('a'), result.archiveTimes.a)
    assert.equal(state.archiveTimeOf('x'), null) // legacy: never invented
  }
  assert.deepEqual(ops(calls), ['archive:a'])

  const again = await svc.archive(['x'])
  assert.equal(again.ok, true)
  if (again.ok) {
    assert.deepEqual(again.archivedIds, [])
    assert.deepEqual(again.alreadyArchivedIds, ['x'])
    assert.deepEqual(again.archiveTimes, {})
  }
  assert.deepEqual(ops(calls), ['archive:a']) // no second archiveSession call
})

test('duplicate ids normalize before the archive batch dispatches', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({ calls, snapshots: [{ header: { id: 'a' } }] })
  const svc = new SessionManagerService(services, state)

  const result = await svc.archive(['a', 'a', 'a'])
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.archivedIds, ['a'])
  assert.deepEqual(ops(calls), ['archive:a']) // dispatched exactly once
})

test('archive maps persistence listing faults to a structured result', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({ calls })
  services.persistence!.listSnapshots = async () => { throw new Error('list-boom') }
  const result = await new SessionManagerService(services, state).archive(['a'])

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'persistence-failed')
    assert.equal(result.error.details?.cause, 'list-boom')
  }
  assert.deepEqual(ops(calls), [])
})

test('unarchive restores official membership, removes plugin timestamp, and reports final archive set', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await state.writeArchiveTimes({ a: '2026-01-01T00:00:00.000Z', legacy: '2025-01-01T00:00:00.000Z' })
  const calls: CallRec[] = []
  const archived = ['a', 'b']
  const services = makeHost({
    calls,
    snapshots: [{ header: { id: 'a' } }, { header: { id: 'b' } }, { header: { id: 'c' } }],
    archivedSessionIds: archived,
    unarchive: async (id) => { const index = archived.indexOf(id); if (index >= 0) archived.splice(index, 1) },
  })
  Object.defineProperty(services.workspaces!, 'archivedSessionIds', { get: () => archived })
  const result = await new SessionManagerService(services, state).unarchive(['a', 'c', 'a'])

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.unarchivedIds, ['a'])
    assert.deepEqual(result.alreadyActiveIds, ['c'])
    assert.deepEqual(result.archivedSessionIds, ['b'])
  }
  assert.deepEqual(ops(calls), ['unarchive:a'])
  assert.equal(state.archiveTimeOf('a'), null)
  assert.equal(state.archiveTimeOf('legacy'), '2025-01-01T00:00:00.000Z')
})

test('partial unarchive failure is atomically compensated by re-archive', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    snapshots: [{ header: { id: 'a' } }, { header: { id: 'b' } }],
    archivedSessionIds: ['a', 'b'],
    unarchive: async (id) => { if (id === 'b') throw new Error('restore-boom') },
  })
  const result = await new SessionManagerService(services, state).unarchive(['a', 'b'])
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'archive-partial')
    assert.deepEqual(result.error.details?.unarchivedBeforeFailure, ['a'])
    assert.deepEqual(result.error.details?.rollbackErrors, [])
  }
  assert.deepEqual(ops(calls), ['unarchive:a', 'unarchive:b', 'archive:a'])
})

test('archive rejects invalid, empty and unknown batches before any mutation', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({ calls, snapshots: [{ header: { id: 'a' } }] })
  const svc = new SessionManagerService(services, state)

  const empty = await svc.archive([])
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.error.code, 'empty-batch')

  const invalid = await svc.archive('a' as unknown as readonly unknown[])
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'invalid-request')

  const unknown = await svc.archive(['zz'])
  assert.equal(unknown.ok, false)
  if (!unknown.ok) {
    assert.equal(unknown.error.code, 'unknown-session')
    assert.deepEqual(unknown.error.details?.ids, ['zz'])
  }

  assert.deepEqual(ops(calls), []) // archiveSession never called
})
