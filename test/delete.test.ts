import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { makeHost, mkTmp, ops, recordingFileOps, sleep, writeSessionDir } from './helpers.ts'
import type { CallRec } from './helpers.ts'
import { SessionManagerService } from '../src/session-service.ts'
import { pathExists, PluginStateStore, TRASH_PREFIX } from '../src/state.ts'

test('0.1.5 versioned artifact names (session.v3.jsonl.zstd) pass staging validation', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const id = 'session-dsm-lab'
  await writeSessionDir(root, id)
  const artifactDir = join(root, 'project', id)
  // The 0.1.5 backend persists the current generation under the versioned name.
  await rename(join(artifactDir, 'session.jsonl'), join(artifactDir, 'session.v3.jsonl.zstd'))
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    root,
    snapshots: [{ header: { id } }],
    locateImpl: () => ({ kind: 'jsonl', path: join(artifactDir, 'session.v3.jsonl.zstd') }),
  })
  const svc = new SessionManagerService(services, state)

  const result = await svc.delete([id])
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.deletedIds, [id])
  // Whole session directory staged away; the versioned artifact did not stall the flow.
  assert.equal(await pathExists(artifactDir), false)
  assert.equal(await state.readJournal(), null)
})

test('invalid, empty, oversized and unknown batches are rejected before any disposal', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const services = makeHost({ calls, snapshots: [{ header: { id: 's1' } }] })
  const svc = new SessionManagerService(services, state)

  const cases: Array<{ input: unknown; code: string }> = [
    { input: [], code: 'empty-batch' },
    { input: 's1', code: 'invalid-request' },
    { input: ['', 's1'], code: 'invalid-request' },
    { input: ['   ', 's1'], code: 'invalid-request' },
    { input: ['x'.repeat(257)], code: 'invalid-request' },
  ]
  for (const { input, code } of cases) {
    const result = await svc.delete(input as readonly unknown[])
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, code)
  }

  const unknown = await svc.delete(['nope'])
  assert.equal(unknown.ok, false)
  if (!unknown.ok) {
    assert.equal(unknown.error.code, 'unknown-session')
    assert.deepEqual(unknown.error.details?.ids, ['nope'])
  }

  assert.deepEqual(ops(calls), []) // dispose/inspect never reached
  assert.equal(await state.readJournal(), null)
})

test('duplicate ids are deduplicated before the batch is dispatched', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await writeSessionDir(root, 's1')
  const calls: CallRec[] = []
  const services = makeHost({ calls, root, snapshots: [{ header: { id: 's1' } }] })
  const svc = new SessionManagerService(services, state)

  const result = await svc.delete(['s1', 's1', 's1'])
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.deletedIds, ['s1'])
  const reserve = calls.find((call) => call.op === 'reserve')
  assert.deepEqual(reserve?.args?.[0], ['s1']) // dispatched exactly once
})

test('running and attached-legacy blockers reject the whole batch without touching artifacts', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await writeSessionDir(root, 's1')
  await writeSessionDir(root, 's2')
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    root,
    snapshots: [{ header: { id: 's1' } }, { header: { id: 's2' } }],
    disposal: async () => ({
      ok: false,
      blockers: [
        { id: 's1', status: 'running' },
        { id: 's2', status: 'attached-legacy' },
      ],
    }),
  })
  const svc = new SessionManagerService(services, state)

  const result = await svc.delete(['s1', 's2'])
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'blocked')
    assert.deepEqual(result.error.details?.blockers, [
      { id: 's1', status: 'running' },
      { id: 's2', status: 'attached-legacy' },
    ])
  }
  assert.deepEqual(ops(calls), ['reserve']) // no token, inspect/locate/rename/forget/release
  assert.equal(await state.readJournal(), null)
  assert.ok(await pathExists(join(root, 'project', 's1', 'session.jsonl')))
  assert.ok(await pathExists(join(root, 'project', 's2', 'session.jsonl')))
})

test('successful live idle + cold delete keeps strict phase ordering and stages only session dirs', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await state.writeArchiveTimes({ s1: 't1', s2: 't2' })
  await writeSessionDir(root, 's1', ['attachments/note.txt'])
  await writeSessionDir(root, 's2')
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    root,
    snapshots: [{ header: { id: 's2', createdAt: 2000 } }],
    liveAgents: [{
      id: 's1',
      status: 'idle',
      session: { id: 's1', header: { id: 's1', createdAt: 1000 }, events: [] },
    }],
    disposal: async (ids) => {
      calls.push({ op: 'dispose:start', args: [[...ids]] })
      await sleep(10)
      calls.push({ op: 'dispose:done' })
      return { ok: true, reservationToken: 'test-reservation', disposedIds: ids.filter((id) => id === 's1') }
    },
  })
  const fileOps = recordingFileOps(calls)
  const svc = new SessionManagerService(services, state, fileOps)

  const result = await svc.delete(['s1', 's2'])
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.deletedIds, ['s1', 's2'])
    assert.deepEqual(result.disposedIds, ['s1']) // cold s2 is not agent-disposed
    assert.deepEqual(result.pendingCleanup, [])
  }

  // Phase ordering: disposal completes -> every inspect/locate before the first
  // rename -> every rename before the first forget -> forgets before cleanup.
  const seq = ops(calls)
  assert.equal(seq[0], 'reserve')
  assert.ok(seq.indexOf('dispose:done') >= 0)
  assert.ok(seq.indexOf('dispose:done') < seq.indexOf('inspect:s1'))
  const preOps = ['inspect', 'locate', 'exists']
  const lastPre = Math.max(...seq.map((op, index) => (preOps.some((p) => op.startsWith(p)) ? index : -1)))
  const firstRename = seq.findIndex((op) => op.startsWith('rename'))
  const lastRename = Math.max(...seq.map((op, index) => (op.startsWith('rename') ? index : -1)))
  const firstForget = seq.findIndex((op) => op.startsWith('forget'))
  const lastForget = Math.max(...seq.map((op, index) => (op.startsWith('forget') ? index : -1)))
  const firstRm = seq.findIndex((op) => op.startsWith('rm'))
  assert.ok(lastPre >= 0 && lastPre < firstRename)
  assert.ok(lastRename < firstForget)
  assert.ok(firstRm >= 0 && lastForget < firstRm)

  // No child cascade: forget is called exactly once per top-level id.
  assert.deepEqual(calls.filter((call) => call.op === 'forget').map((call) => call.id), ['s1', 's2'])
  assert.deepEqual(calls.filter((call) => call.op === 'reserve').map((call) => call.args?.[0]), [['s1', 's2']])
  assert.deepEqual(calls.filter((call) => call.op === 'release').map((call) => call.id), ['test-reservation'])

  // Each session is staged in two safe renames: hide the backend candidate
  // filename inside its own dir, then move that dir to a same-parent trash name.
  const project = join(root, 'project')
  const renames = calls.filter((call) => call.op === 'rename')
  const artifactRenames = renames.filter((call) => basename(call.args![0] as string) === 'session.jsonl')
  const directoryRenames = renames.filter((call) => ['s1', 's2'].includes(basename(call.args![0] as string)))
  assert.equal(artifactRenames.length, 2)
  assert.equal(directoryRenames.length, 2)
  for (const call of artifactRenames) {
    const [from, to] = call.args as [string, string]
    assert.equal(dirname(from), dirname(to))
    assert.ok(basename(to).startsWith('.dsh-manage-sessions-artifact-'))
    assert.ok(!to.includes('attachments'))
  }
  for (const call of directoryRenames) {
    const [from, to] = call.args as [string, string]
    assert.ok(!from.includes('attachments') && !to.includes('attachments'))
    assert.equal(dirname(from), project)
    assert.equal(dirname(to), project)
    assert.ok(basename(to).startsWith(TRASH_PREFIX))
  }

  assert.ok(!(await pathExists(join(project, 's1'))))
  assert.ok(!(await pathExists(join(project, 's2'))))
  assert.deepEqual(await readdir(project), [])

  // Committed success: archive timestamps removed and journal cleared.
  assert.equal(await state.readJournal(), null)
  assert.equal(state.archiveTimeOf('s1'), null)
  assert.equal(state.archiveTimeOf('s2'), null)
  const onDisk = JSON.parse(await readFile(join(root, 'state', 'archive-times.json'), 'utf8')) as { times: Record<string, string> }
  assert.deepEqual(onDisk.times, {})
})

test('second rename failure restores the first rename, forgets nothing, and clears the journal', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await writeSessionDir(root, 's1')
  await writeSessionDir(root, 's2')
  const calls: CallRec[] = []
  const services = makeHost({
    calls,
    root,
    snapshots: [{ header: { id: 's1' } }, { header: { id: 's2' } }],
  })
  const fileOps = recordingFileOps(calls, { failRenameAt: 2 })
  const svc = new SessionManagerService(services, state, fileOps)

  const result = await svc.delete(['s1', 's2'])
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'staging-failed')
    assert.equal(result.error.details?.cause, 'rename-boom')
    assert.deepEqual(result.error.details?.rollbackErrors, []) // restore succeeded
  }
  assert.deepEqual(calls.filter((call) => call.op === 'forget'), []) // no forget
  assert.equal(await state.readJournal(), null) // journal cleaned after clean rollback
  assert.ok(await pathExists(join(root, 'project', 's1', 'session.jsonl')))
  assert.ok(await pathExists(join(root, 'project', 's2', 'session.jsonl')))
  const leftovers = (await readdir(join(root, 'project'))).filter((name) => name.startsWith(TRASH_PREFIX))
  assert.deepEqual(leftovers, [])
})

test('validation failure releases the deletion lease before returning', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const calls: CallRec[] = []
  const svc = new SessionManagerService(makeHost({
    calls,
    snapshots: [{ header: { id: 's1' } }],
    locateImpl: () => ({ kind: 'jsonl', path: join(root, 'attachments', 'shared', 'session.jsonl') }),
  }), state)

  const result = await svc.delete(['s1'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'unsafe-location')
  assert.deepEqual(ops(calls).filter((op) => op === 'reserve' || op.startsWith('release')), ['reserve', 'release:test-reservation'])
  assert.equal(await state.readJournal(), null)
})

test('post-commit-point failure retains the deletion lease for startup forward recovery', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await writeSessionDir(root, 's1')
  const calls: CallRec[] = []
  const svc = new SessionManagerService(makeHost({
    calls,
    root,
    snapshots: [{ header: { id: 's1' } }],
    forget: async () => { throw new Error('forget-boom') },
  }), state, recordingFileOps(calls))

  const result = await svc.delete(['s1'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'forget-failed')
  assert.equal(calls.some((call) => call.op === 'release'), false)
  const journal = await state.readJournal()
  assert.equal(journal?.phase, 'committing')
})

test('unsafe artifact paths and non-ENOENT stat failures stop before metadata mutation', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const snapshots = [{ header: { id: 's1' } }]

  const unsafeCalls: CallRec[] = []
  const unsafe = new SessionManagerService(makeHost({
    calls: unsafeCalls,
    snapshots,
    locateImpl: () => ({ kind: 'jsonl', path: join(root, 'attachments', 'shared', 'session.jsonl') }),
  }), state)
  const unsafeResult = await unsafe.delete(['s1'])
  assert.equal(unsafeResult.ok, false)
  if (!unsafeResult.ok) assert.equal(unsafeResult.error.code, 'unsafe-location')
  assert.deepEqual(unsafeCalls.filter((call) => call.op === 'forget'), [])
  assert.equal(await state.readJournal(), null)

  const statCalls: CallRec[] = []
  const statFailure = new SessionManagerService(makeHost({ calls: statCalls, root, snapshots }), state, {
    exists: async () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    },
    rename: async () => { throw new Error('rename must not run') },
    removeTrash: async () => { throw new Error('cleanup must not run') },
  })
  const statResult = await statFailure.delete(['s1'])
  assert.equal(statResult.ok, false)
  if (!statResult.ok) assert.equal(statResult.error.code, 'inspect-failed')
  assert.deepEqual(statCalls.filter((call) => call.op === 'forget'), [])
  assert.equal(await state.readJournal(), null)
})

test('a corrupt pending journal fails closed and is never overwritten', async () => {
  const root = await mkTmp()
  const stateDir = join(root, 'state')
  const state = await PluginStateStore.open(stateDir)
  const corrupt = '{broken-journal\n'
  await writeFile(join(stateDir, 'journal.json'), corrupt, 'utf8')
  const calls: CallRec[] = []
  const svc = new SessionManagerService(makeHost({ calls, snapshots: [{ header: { id: 's1' } }] }), state)

  const result = await svc.delete(['s1'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'journal-failed')
  assert.deepEqual(calls.filter((call) => call.op === 'reserve'), [])
  assert.equal(await readFile(join(stateDir, 'journal.json'), 'utf8'), corrupt)
})

test('committed success removes the timestamp; cleanup failure keeps the committed journal and reports pending', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await state.writeArchiveTimes({ s1: 't1' })
  await writeSessionDir(root, 's1')
  const calls: CallRec[] = []
  const services = makeHost({ calls, root, snapshots: [{ header: { id: 's1' } }] })
  const fileOps = recordingFileOps(calls, { failRemoveTrash: true })
  const svc = new SessionManagerService(services, state, fileOps)

  const result = await svc.delete(['s1'])
  assert.equal(result.ok, true)
  const pending = result.ok ? result.pendingCleanup : null
  assert.ok(pending && pending.length === 1)
  if (pending) assert.ok(pending[0].includes(TRASH_PREFIX))
  if (result.ok) assert.deepEqual(result.deletedIds, ['s1'])

  assert.equal(state.archiveTimeOf('s1'), null) // metadata commit still completed

  // Journal stays at phase committed because cleanup could not finish.
  const journal = await state.readJournal()
  assert.ok(journal)
  if (journal) {
    assert.equal(journal.phase, 'committed')
    assert.deepEqual(journal.ids, ['s1'])
    if (pending) assert.equal(journal.entries[0].staged, pending[0])
  }

  assert.ok(!(await pathExists(join(root, 'project', 's1'))))
  const leftovers = (await readdir(join(root, 'project'))).filter((name) => name.startsWith(TRASH_PREFIX))
  assert.equal(leftovers.length, 1) // trash still on disk for recovery
  assert.equal((await readdir(join(root, 'project', leftovers[0]))).some((name) => name === 'session.jsonl' || name === 'session.jsonl.zstd'), false)

  // A pending journal is a hard gate: no later delete may overwrite its
  // recovery record or reach agent disposal.
  const second = await svc.delete(['s1'])
  assert.equal(second.ok, false)
  if (!second.ok) {
    assert.equal(second.error.code, 'blocked')
    assert.deepEqual(second.error.details?.pendingJournal, { txnId: journal?.txnId, phase: 'committed' })
  }
  assert.equal(calls.filter((call) => call.op === 'reserve').length, 1)
  assert.equal(calls.filter((call) => call.op === 'release').length, 1)
})
