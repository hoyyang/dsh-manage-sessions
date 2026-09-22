import { test } from 'node:test'
import assert from 'node:assert/strict'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { probeCapabilities } from '../src/capabilities.ts'

test('installed workspace core contract unarchives durably without changing accounting', async () => {
  const state = { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['a', 'b'] }
  const writes: typeof state[] = []
  const owner = {
    enqueueOperation: <T>(run: () => Promise<T>) => run(),
    requireState: () => state,
    setState: async (next: typeof state) => { writes.push(structuredClone(next)); Object.assign(state, next) },
  }
  const unarchive = (WorkspaceRegistry.prototype as unknown as { unarchiveSession(id: string): Promise<void> }).unarchiveSession
  assert.equal(typeof unarchive, 'function')
  await unarchive.call(owner, 'b')
  await unarchive.call(owner, 'missing')
  assert.equal(writes.length, 1)
  assert.deepEqual(state.workspaceIds, ['w1'])
  assert.deepEqual(state.archivedSessionIds, ['a'])

  const services = {
    agents: undefined,
    workspaces: {
      get: () => undefined,
      list: () => [], archivedSessionIds: [], archiveSession: async () => {},
      unarchiveSession: async () => {}, forgetSession: async () => {},
    },
    persistence: undefined,
    projections: undefined,
    projectionCache: undefined,
    webServer: undefined,
  }
  // Archive/unarchive preflight their ids through the persistence catalogue, so
  // the capability must stay off when that read is absent (the pre-0.2.0 probe
  // advertised it anyway and every call then died on a missing method).
  assert.equal(probeCapabilities(services, true).archiveBatch, false)
  assert.equal(probeCapabilities(services, true).archive, false)
  assert.equal(probeCapabilities(services, true).unarchiveAvailable, false)
  const withCatalogue = {
    ...services,
    persistence: { listSnapshots: async () => [], locate: () => undefined },
  }
  const ready = probeCapabilities(withCatalogue, true)
  assert.equal(ready.archive, true)
  assert.equal(ready.archiveBatch, true)
  assert.equal(ready.unarchiveAvailable, true)
})
