import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fullBreakdown, fullStats, fullTokens, makeHost, mkTmp, pressure } from './helpers.ts'
import type { CallRec } from './helpers.ts'
import { SessionManagerService } from '../src/session-service.ts'
import { PluginStateStore } from '../src/state.ts'

test('catalog uses cache-only enrichment and never folds cold logs on a cache miss', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    snapshots: [{ header: { id: 'cached', createdAt: 1 } }, { header: { id: 'miss', createdAt: 2 } }],
    cachedSnapshot: (meta) => meta.id === 'cached' ? { asOfSeq: 1, values: { title: { title: 'Cached title' } } } : undefined,
    coldSnapshot: async (id) => ({ asOfSeq: 1, values: { title: { title: `Loaded ${id}` } } }),
  })

  const payload = await new SessionManagerService(services, state).catalog()
  assert.equal(payload.activeSessions.find((item) => item.id === 'cached')?.title, 'Cached title')
  assert.equal(payload.activeSessions.find((item) => item.id === 'miss')?.title, null)
  assert.deepEqual(calls.filter((call) => call.op === 'coldSnapshot'), [])
})

test('catalog computes updatedAt for very large live histories without argument spreading', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const events = Array.from({ length: 200_000 }, (_, index) => ({ time: index }))
  const services = makeHost({
    calls: [],
    snapshots: [{ header: { id: 'large', createdAt: 1 } }],
    liveAgents: [{
      id: 'large',
      status: 'idle',
      session: { id: 'large', header: { id: 'large', createdAt: 1 }, events },
    }],
  })

  const payload = await new SessionManagerService(services, state).catalog()
  assert.equal(payload.activeSessions[0].updatedAt, 199_999)
})

test('catalog groups workspaces and orphans with active/archived detail and legacy archiveTime', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await state.writeArchiveTimes({ s4: '2024-05-01T12:00:00.000Z' })
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    root,
    snapshots: [
      { header: { id: 's1', createdAt: 1000, cwd: '/p1', parentSession: 'parent1', origin: 'subagent', delegationDepth: 2 } },
      { header: { id: 's2', createdAt: 2000, cwd: '/p2' } },
      { header: { id: 's3', createdAt: 3000 } },
      { header: { id: 's4', createdAt: 4000 } },
    ],
    liveAgents: [{
      id: 's1',
      status: 'running',
      session: {
        id: 's1',
        header: { id: 's1', createdAt: 1000, cwd: '/p1' },
        events: [{ time: 1500 }, { time: 1600 }],
      },
    }],
    workspaces: [
      { id: 'w1', path: '/w1', title: 'Work', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z', sessionIds: ['s1', 's2'] },
      { id: 'w2', path: '/w2', title: 'Empty', createdAt: '2024-01-03T00:00:00.000Z', updatedAt: '2024-01-04T00:00:00.000Z', sessionIds: [] },
    ],
    archivedSessionIds: ['s2', 's4'],
    liveSnapshot: (session) => ({
      asOfSeq: 1,
      values: {
        title: { title: `Live ${session.id}` },
        sessionStats: fullStats(),
        tokenUsage: fullTokens(),
        contextPressure: pressure(),
        contextBreakdown: fullBreakdown(),
      },
    }),
    cachedSnapshot: (meta) => meta.id === 's2'
      ? {
          asOfSeq: 1,
          values: {
            title: { title: 'Cached s2' },
            sessionStats: fullStats(),
            tokenUsage: fullTokens(),
            contextPressure: { pressureTokens: 10 },
            contextBreakdown: fullBreakdown(),
          },
        }
      : undefined,
    coldSnapshot: async () => { throw new Error('cold enrichment must never run') },
  })
  const svc = new SessionManagerService(services, state)
  const payload = await svc.catalog()

  assert.equal(payload.ok, true)
  assert.equal(payload.capabilities.catalog, true)
  assert.equal(typeof payload.generatedAt, 'string')

  // Workspace groups keep official order and only account for their members.
  assert.equal(payload.workspaces.length, 2)
  const w1 = payload.workspaces[0]
  assert.equal(w1.id, 'w1')
  assert.equal(w1.title, 'Work')
  assert.equal(w1.path, '/w1')
  assert.equal(w1.createdAt, '2024-01-01T00:00:00.000Z')
  assert.deepEqual(w1.sessionIds, ['s1', 's2'])
  assert.deepEqual(w1.sessions.map((s) => s.id), ['s1', 's2'])
  assert.deepEqual(payload.workspaces[1].sessions, [])

  // Orphans are snapshots no workspace accounts for (s4 is also archived but
  // keeps no workspace slot in this fixture).
  assert.deepEqual(payload.orphans.sessionIds, ['s3', 's4'])
  assert.equal(payload.orphans.sessions[0].id, 's3')

  assert.deepEqual(payload.archivedSessionIds, ['s2', 's4'])
  assert.deepEqual(payload.archived.map((s) => s.id), ['s2', 's4'])
  assert.deepEqual(payload.archivedSessions.map((s) => s.id), ['s2', 's4'])
  assert.deepEqual(payload.activeSessions.map((s) => s.id), ['s1', 's3'])

  // Live running session: full projection detail, event-time updatedAt.
  const s1 = payload.activeSessions[0]
  assert.equal(s1.status, 'running')
  assert.equal(s1.running, true)
  assert.equal(s1.archived, false)
  assert.equal(s1.archiveTime, null)
  assert.equal(s1.createdAt, 1000)
  assert.equal(s1.updatedAt, 1600)
  assert.equal(s1.cwd, '/p1')
  assert.equal(s1.parent, 'parent1')
  assert.equal(s1.subagent, true)
  assert.equal(s1.delegationDepth, 2)
  assert.equal(s1.title, 'Live s1')
  assert.deepEqual(s1.stats, fullStats())
  assert.equal(s1.agentWorkMs, 150) // llmMs + toolMs
  assert.deepEqual(s1.tokenUsage, fullTokens())
  assert.deepEqual(s1.contextBreakdown, fullBreakdown())
  assert.deepEqual(s1.contextPressure, pressure())

  // Archived cold session: detail survives, plugin-owned stamp is absent (legacy).
  const s2 = payload.archived[0]
  assert.equal(s2.status, 'cold')
  assert.equal(s2.running, false)
  assert.equal(s2.archived, true)
  assert.equal(s2.archiveTime, null) // legacy archive: never stamped by this plugin
  assert.equal(s2.createdAt, 2000)
  assert.equal(s2.updatedAt, 2000) // cold: falls back to createdAt
  assert.equal(s2.cwd, '/p2')
  assert.equal(s2.parent, null)
  assert.equal(s2.subagent, false)
  assert.equal(s2.delegationDepth, 0)
  assert.equal(s2.title, 'Cached s2')
  assert.deepEqual(s2.stats, fullStats())
  assert.equal(s2.agentWorkMs, 150)
  assert.deepEqual(s2.tokenUsage, fullTokens())
  assert.deepEqual(s2.contextBreakdown, fullBreakdown())
  assert.deepEqual(s2.contextPressure, { pressureTokens: 10 }) // partial cached pressure view survives
  assert.deepEqual(calls.filter((call) => call.op === 'coldSnapshot'), [])

  // Plugin-owned archive timestamp is served verbatim.
  const s4 = payload.archived[1]
  assert.equal(s4.id, 's4')
  assert.equal(s4.archived, true)
  assert.equal(s4.status, 'cold')
  assert.equal(s4.archiveTime, '2024-05-01T12:00:00.000Z')

  // No projection source -> every projected field is null.
  const s3 = payload.activeSessions[1]
  assert.equal(s3.id, 's3')
  assert.equal(s3.title, null)
  assert.equal(s3.stats, null)
  assert.equal(s3.tokenUsage, null)
  assert.equal(s3.contextBreakdown, null)
  assert.equal(s3.contextPressure, null)
  assert.equal(s3.agentWorkMs, null)
  assert.equal(s3.createdAt, 3000)
  assert.equal(s3.updatedAt, 3000)
  assert.equal(s3.archiveTime, null)
})
