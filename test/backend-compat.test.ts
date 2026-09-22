import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkTmp } from './helpers.ts'
import { trashPathFor } from '../src/state.ts'

/**
 * Compatibility smoke against the installed 0.1.5 backend, not a copied scanner:
 * staged trash must be invisible rather than an identity-corrupt artifact.
 */
test('dual-rename staging stays invisible to the real JSONL backend scanner', async () => {
  const root = await mkTmp()
  const ctx = new Context()
  Object.defineProperty(ctx, 'sessions', { value: { list: () => [] }, configurable: true })
  const backend = new JsonlSessionPersistence(ctx, { root, compression: 'none' })
  const meta = { id: 's1', createdAt: 1, delegationDepth: 0 }
  const location = (backend as unknown as { locate(meta: unknown): { kind: string; path: string } }).locate(meta)
  // 0.1.5 names each artifact generation with the format version it stores
  // (`<id>.v3.jsonl`), and the scanner refuses a header whose version differs.
  // Read the generation off the resolved path instead of pinning a number.
  const generation = Number(/\.v(\d+)\.jsonl/.exec(location.path)?.[1] ?? 1)
  await mkdir(dirname(location.path), { recursive: true })
  await writeFile(location.path, `${JSON.stringify({ type: 'session', version: generation, isSeeded: false, ...meta })}\n`, 'utf8')
  assert.deepEqual((await backend.list()).map((item) => item.header.id), ['s1'])

  const originalDir = dirname(location.path)
  const hiddenName = '.dsh-manage-sessions-artifact-test'
  const stagedDir = trashPathFor(originalDir, 'backend-smoke')
  await rename(location.path, join(originalDir, hiddenName))
  await rename(originalDir, stagedDir)

  // This call threw a stored-identity corruption error under directory-only staging.
  assert.deepEqual(await backend.list(), [])

  await rename(stagedDir, originalDir)
  await rename(join(originalDir, hiddenName), location.path)
  assert.deepEqual((await backend.list()).map((item) => item.header.id), ['s1'])
})
