import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rename as fsRename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeHost, mkTmp, writeSessionDir } from './helpers.ts'
import type { CallRec } from './helpers.ts'
import { pathExists, PluginStateStore, trashPathFor } from '../src/state.ts'
import { journalPathOf, recoverState } from '../src/recovery.ts'
import type { DeleteJournal, StagedEntry } from '../src/types.ts'

function stagedEntry(id: string, original: string, staged: string, hidden = `.dsh-manage-sessions-artifact-test`): StagedEntry {
  return {
    id,
    original,
    staged,
    preexisting: true,
    artifactOriginal: join(original, 'session.jsonl'),
    artifactHiddenName: hidden,
  }
}

async function stageEntry(entry: StagedEntry): Promise<void> {
  await fsRename(entry.artifactOriginal, join(entry.original, entry.artifactHiddenName))
  await fsRename(entry.original, entry.staged)
}

function journal(entries: DeleteJournal['entries'], ids: string[], phase: DeleteJournal['phase'], txnId: string): DeleteJournal {
  return { version: 1, txnId, ids, entries, phase, startedAt: new Date().toISOString() }
}

test('recoverState restores staged entries and clears the journal', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const dir = await writeSessionDir(root, 's1')
  const staged = trashPathFor(dir, 'txn-1')
  const entry = stagedEntry('s1', dir, staged)
  await stageEntry(entry)
  await state.writeJournal(journal([entry], ['s1'], 'staged', 'txn-1'))

  const report = await recoverState(state)
  assert.equal(report.found, true)
  assert.equal(report.action, 'restored')
  assert.deepEqual(report.restored, ['s1'])
  assert.deepEqual(report.cleaned, [])
  assert.deepEqual(report.deferred, [])
  assert.ok(await pathExists(dir))
  assert.ok(!(await pathExists(staged)))
  assert.ok((await readFile(join(dir, 'session.jsonl'), 'utf8')).includes('s1'))
  assert.equal(await state.readJournal(), null)
  assert.equal(journalPathOf(state), join(root, 'state', 'journal.json'))
})

test('recoverState forward-commits a committing journal: forget all, drop timestamps, clean trash', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  await state.writeArchiveTimes({ s1: 't1', s2: 't2' })
  const d1 = await writeSessionDir(root, 's1')
  const d2 = await writeSessionDir(root, 's2')
  const staged1 = trashPathFor(d1, 'txn-2')
  const staged2 = trashPathFor(d2, 'txn-2')
  const entry1 = stagedEntry('s1', d1, staged1)
  const entry2 = stagedEntry('s2', d2, staged2)
  await stageEntry(entry1)
  await stageEntry(entry2)
  await state.writeJournal(journal([entry1, entry2], ['s1', 's2'], 'committing', 'txn-2'))

  const calls: CallRec[] = []
  const services = makeHost({ calls, root })
  const report = await recoverState(state, { workspaces: services.workspaces! })

  assert.equal(report.found, true)
  assert.equal(report.action, 'forwarded-commit')
  assert.deepEqual(report.restored, [])
  assert.deepEqual(report.cleaned, ['s1', 's2'])
  assert.deepEqual(report.deferred, [])
  assert.deepEqual(calls.filter((c) => c.op === 'forget').map((c) => c.id), ['s1', 's2'])
  assert.equal(state.archiveTimeOf('s1'), null)
  assert.equal(state.archiveTimeOf('s2'), null)
  assert.ok(!(await pathExists(staged1)))
  assert.ok(!(await pathExists(staged2)))
  assert.equal(await state.readJournal(), null)
})

test('recoverState finishes trash cleanup for a committed journal', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const dir = await writeSessionDir(root, 's1')
  const staged = trashPathFor(dir, 'txn-3')
  const entry = stagedEntry('s1', dir, staged)
  await stageEntry(entry)
  await state.writeJournal(journal([entry], ['s1'], 'committed', 'txn-3'))

  const report = await recoverState(state)
  assert.equal(report.found, true)
  assert.equal(report.action, 'finished-cleanup')
  assert.deepEqual(report.cleaned, ['s1'])
  assert.deepEqual(report.restored, [])
  assert.deepEqual(report.deferred, [])
  assert.ok(!(await pathExists(staged)))
  assert.equal(await state.readJournal(), null)
})

test('recoverState repairs an artifact-hidden-only staging crash', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const dir = await writeSessionDir(root, 's1')
  const entry = stagedEntry('s1', dir, trashPathFor(dir, 'txn-hidden'))
  await fsRename(entry.artifactOriginal, join(entry.original, entry.artifactHiddenName))
  await state.writeJournal(journal([entry], ['s1'], 'staging', 'txn-hidden'))

  const report = await recoverState(state)
  assert.equal(report.action, 'restored')
  assert.deepEqual(report.deferred, [])
  assert.ok(await pathExists(entry.artifactOriginal))
  assert.ok(!(await pathExists(join(entry.original, entry.artifactHiddenName))))
  assert.equal(await state.readJournal(), null)
})

test('recoverState quarantines collision data outside the persistence tree', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const dir = await writeSessionDir(root, 's1')
  const staged = trashPathFor(dir, 'txn-collision')
  const entry = stagedEntry('s1', dir, staged)
  await stageEntry(entry)
  await writeSessionDir(root, 's1')
  await writeFile(join(dir, 'new-marker'), 'new', 'utf8')
  await state.writeJournal(journal([entry], ['s1'], 'staged', 'txn-collision'))

  const report = await recoverState(state)
  assert.equal(report.action, 'restored')
  assert.deepEqual(report.deferred, [])
  assert.match(report.warnings.join('\n'), /preserved outside persistence/)
  assert.equal(await readFile(join(dir, 'new-marker'), 'utf8'), 'new')
  assert.ok(!(await pathExists(staged)))
  assert.ok((await readdir(state.dir)).some((name) => name.startsWith('quarantine-txn-collision-')))
  assert.equal(await state.readJournal(), null)
})

test('recoverState defers a semantic-invalid journal without touching its target', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const victim = join(root, 'project', '.dsh-manage-sessions-trash-victim')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(victim, { recursive: true }))
  await writeFile(join(victim, 'keep'), 'safe', 'utf8')
  const malicious = {
    version: 1,
    txnId: 'other-txn',
    ids: ['s1'],
    phase: 'committed',
    startedAt: new Date().toISOString(),
    entries: [{
      id: 's1',
      original: join(root, 'project', 's1'),
      staged: victim,
      preexisting: true,
      artifactOriginal: join(root, 'project', 's1', 'session.jsonl'),
      artifactHiddenName: '..',
    }],
  }
  await writeFile(join(state.dir, 'journal.json'), JSON.stringify(malicious), 'utf8')

  const report = await recoverState(state)
  assert.equal(report.found, true)
  assert.equal(report.action, 'deferred')
  assert.match(report.warnings.join('\n'), /unreadable and was preserved/)
  assert.equal(await readFile(join(victim, 'keep'), 'utf8'), 'safe')
  assert.ok(await pathExists(join(state.dir, 'journal.json')))
})

test('recoverState reports none when there is no journal', async () => {
  const root = await mkTmp()
  const state = await PluginStateStore.open(join(root, 'state'))
  const report = await recoverState(state)
  assert.equal(report.found, false)
  assert.equal(report.action, 'none')
  assert.deepEqual(report.restored, [])
  assert.deepEqual(report.cleaned, [])
  assert.deepEqual(report.deferred, [])
})
