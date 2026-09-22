import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { adaptHostServices, ensureWorkspaceUnarchiveRuntime, safeStateDir, setupHost } from '../src/index.ts'
import { PluginStateStore, trashPathFor } from '../src/state.ts'
import { makeHost, mkTmp, ops } from './helpers.ts'
import type { CallRec } from './helpers.ts'
import type { HostServices, WebRouteLike, WebServerLike } from '../src/types.ts'

class OrderedWeb implements WebServerLike {
  readonly routes = new Map<string, WebRouteLike>()
  constructor(private readonly events: string[]) {}
  register(route: WebRouteLike): () => void {
    this.events.push(`register:${route.path}`)
    this.routes.set(route.path, route)
    return () => { this.routes.delete(route.path) }
  }
}

function attachWeb(host: HostServices, events: string[]): OrderedWeb {
  const web = new OrderedWeb(events)
  host.webServer = web
  return web
}

test('safeStateDir keeps plugin state outside the sessions persistence root', () => {
  const sessions = dshHomePath('sessions')
  const standard = safeStateDir(undefined, sessions)
  assert.equal(isAbsolute(standard), true)
  assert.equal(standard, dshHomePath('dsh-manage-sessions'))
  assert.equal(relative(sessions, standard).startsWith('..'), true)
  assert.throws(() => safeStateDir(sessions, sessions), /outside the sessions root/)
  assert.throws(() => safeStateDir(join(sessions, 'nested'), sessions), /outside the sessions root/)
  const separate = join(sessions, '..', 'session-manager-custom')
  assert.equal(safeStateDir(separate, sessions), join(sessions, '..', 'session-manager-custom'))
})

test('safeStateDir rejects existing and prospective symlink escapes into sessions', async () => {
  const root = await mkTmp()
  const sessions = join(root, 'sessions')
  await mkdir(sessions, { recursive: true })
  const direct = join(root, 'state-link')
  await symlink(sessions, direct, 'dir')
  assert.throws(() => safeStateDir(direct, sessions), /outside the sessions root/)

  const parent = join(root, 'state-parent-link')
  await symlink(sessions, parent, 'dir')
  assert.throws(() => safeStateDir(join(parent, 'not-created-yet'), sessions), /outside the sessions root/)
})

test('adaptHostServices preserves actual absence of optional runtime capabilities', () => {
  const raw = {
    agents: { list: () => [], get: () => undefined },
    workspaceRegistry: {
      list: () => [], get: () => undefined, archivedSessionIds: [], archiveSession: async () => {},
    },
    sessionPersistence: { listSnapshots: async () => [] },
    sessionProjections: {},
    sessionProjectionCache: {},
    webServer: { register: () => () => {} },
  }
  const adapted = adaptHostServices(raw as never)
  assert.equal(adapted.agents?.sessionDisposalStatus, undefined)
  assert.equal(adapted.agents?.reserveSessionsForDeletion, undefined)
  assert.equal(adapted.agents?.releaseSessionDeletionReservation, undefined)
  assert.equal(adapted.workspaces?.forgetSession, undefined)
  assert.equal(adapted.persistence?.inspect, undefined)
  assert.equal(adapted.persistence?.locate, undefined)
  assert.equal(adapted.projections?.snapshot, undefined)
  assert.equal(adapted.projectionCache?.coldSnapshot, undefined)
  assert.equal(adapted.projectionCache?.cachedSnapshot, undefined)
})

test('ensureWorkspaceUnarchiveRuntime installs the canonical shim only when absent and viable', async () => {
  const warnings: string[] = []
  const state = { archivedSessionIds: ['a', 'b'] }
  const registry: Record<string, unknown> = {
    enqueueOperation: (operation: () => Promise<void>) => operation(),
    requireState: () => state,
    setState: async (next: { archivedSessionIds: string[] }) => {
      state.archivedSessionIds = next.archivedSessionIds
    },
  }
  const host = { workspaceRegistry: registry }
  assert.equal(ensureWorkspaceUnarchiveRuntime(host, (message) => warnings.push(message)), true)
  assert.equal(warnings.length, 1)
  assert.equal(typeof registry.unarchiveSession, 'function')
  await (registry.unarchiveSession as (id: string) => Promise<void>)('a')
  assert.deepEqual(state.archivedSessionIds, ['b'])
  // A repeated call keeps the existing (now shimmed or native) method untouched.
  assert.equal(ensureWorkspaceUnarchiveRuntime(host), false)

  const native = { workspaceRegistry: { unarchiveSession: async () => {} } }
  assert.equal(ensureWorkspaceUnarchiveRuntime(native), false)

  // Without the canonical mutation primitives the shim fail-closes instead of guessing.
  const bare = { workspaceRegistry: { archiveSession: async () => {} } as Record<string, unknown> }
  assert.equal(ensureWorkspaceUnarchiveRuntime(bare), false)
  assert.equal((bare.workspaceRegistry as Record<string, unknown>).unarchiveSession, undefined)
  assert.equal(ensureWorkspaceUnarchiveRuntime(undefined), false)
  assert.equal(ensureWorkspaceUnarchiveRuntime({}), false)
})

test('setupHost forward-recovers committing metadata before mounting any route', async () => {
  const root = await mkTmp()
  const stateDir = join(root, 'state')
  const state = await PluginStateStore.open(stateDir)
  await state.writeArchiveTimes({ s1: '2026-01-01T00:00:00.000Z' })
  const original = join(root, 'project', 's1')
  const txnId = 'entry-forward-1'
  await state.writeJournal({
    version: 1,
    txnId,
    reservationToken: 'test-reservation',
    ids: ['s1'],
    phase: 'committing',
    startedAt: new Date().toISOString(),
    entries: [{
      id: 's1',
      original,
      staged: trashPathFor(original, txnId),
      preexisting: false,
      artifactOriginal: join(original, 'session.jsonl'),
      artifactHiddenName: `.dsh-manage-sessions-artifact-${txnId}`,
    }],
  })
  const calls: CallRec[] = []
  const events: string[] = []
  const host = makeHost({ calls, forget: async (id) => { events.push(`forget:${id}`) } })
  const release = host.agents!.releaseSessionDeletionReservation!
  host.agents!.releaseSessionDeletionReservation = (token) => { events.push(`release:${token}`); release(token) }
  const web = attachWeb(host, events)

  const setup = await setupHost(host, stateDir, 'entry-test')
  assert.equal(setup.recovery.action, 'forwarded-commit')
  assert.deepEqual(ops(calls).filter((item) => item.startsWith('forget:')), ['forget:s1'])
  assert.equal(events[0], 'forget:s1')
  assert.equal(events[1], 'release:test-reservation')
  assert.equal(events[2], 'register:/dsh-manage-sessions/catalog')
  assert.equal(events[3], 'register:/dsh-manage-sessions/workspaces')
  assert.equal(setup.state.archiveTimeOf('s1'), null)
  assert.equal(await setup.state.readJournal(), null)
  assert.equal(web.routes.size, 7)
  setup.dispose()
  assert.equal(web.routes.size, 0)
})

test('setupHost preserves a corrupt journal, mounts read routes, and blocks deletion before disposal', async () => {
  const root = await mkTmp()
  const stateDir = join(root, 'state')
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, 'journal.json'), '{corrupt\n', 'utf8')
  const calls: CallRec[] = []
  const events: string[] = []
  const host = makeHost({ calls, snapshots: [{ header: { id: 's1' } }] })
  const web = attachWeb(host, events)

  const setup = await setupHost(host, stateDir)
  assert.equal(setup.recovery.action, 'deferred')
  assert.equal(setup.recovery.found, true)
  assert.equal(web.routes.has('/dsh-manage-sessions/catalog'), true)
  const result = await setup.service.delete(['s1'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'journal-failed')
  assert.deepEqual(calls.filter((item) => item.op === 'reserve'), [])
  assert.equal(await (await import('node:fs/promises')).readFile(join(stateDir, 'journal.json'), 'utf8'), '{corrupt\n')
  setup.dispose()
})

test('setupHost rejects a missing web server without exposing routes', async () => {
  const root = await mkTmp()
  const host = makeHost({ calls: [] })
  await assert.rejects(setupHost(host, join(root, 'state')), /webServer is unavailable/)
})
