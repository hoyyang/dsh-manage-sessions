import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionManagerApi, ARCHIVE_URL, CAPABILITIES_URL, DELETE_URL, UNARCHIVE_URL } from '../src/client/api.ts'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('client API sends same-origin no-store requests and exact mutation ids', async () => {
  const calls: Array<{ input: string; init: RequestInit }> = []
  const api = new SessionManagerApi(async (input, init = {}) => {
    calls.push({ input: String(input), init })
    if (String(input) === CAPABILITIES_URL) return response({ ok: true, capabilities: {}, version: 'test' })
    if (String(input) === ARCHIVE_URL) return response({ ok: true, archivedIds: ['a', 'b'], archiveTimes: {}, alreadyArchivedIds: [] })
    if (String(input) === UNARCHIVE_URL) return response({ ok: true, unarchivedIds: ['a', 'b'], alreadyActiveIds: [], archivedSessionIds: [] })
    return response({ ok: true, deletedIds: ['a', 'b'], disposedIds: [], pendingCleanup: [] })
  })

  assert.equal((await api.capabilities()).ok, true)
  assert.equal((await api.archive(['a', 'b'])).ok, true)
  assert.equal((await api.unarchive(['a', 'b'])).ok, true)
  assert.equal((await api.delete(['a', 'b'])).ok, true)
  assert.deepEqual(calls.map((call) => call.input), [CAPABILITIES_URL, ARCHIVE_URL, UNARCHIVE_URL, DELETE_URL])
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.body, JSON.stringify({ ids: ['a', 'b'] }))
  assert.equal(calls[2].init.body, JSON.stringify({ ids: ['a', 'b'] }))
  assert.equal(calls[3].init.body, JSON.stringify({ ids: ['a', 'b'] }))
})

test('client API preserves structured host errors and converts bad transport bodies', async () => {
  const blocked = new SessionManagerApi(async () => response({ ok: false, error: { code: 'blocked', message: 'rejected', details: { blockers: [{ id: 's1', status: 'running' }] } } }, 409))
  const blockedResult = await blocked.delete(['s1'])
  assert.equal(blockedResult.ok, false)
  if (!blockedResult.ok) {
    assert.equal(blockedResult.error.code, 'blocked')
    assert.deepEqual(blockedResult.error.details?.blockers, [{ id: 's1', status: 'running' }])
  }

  const invalid = new SessionManagerApi(async () => new Response('<html>bad</html>', { status: 500 }))
  const invalidResult = await invalid.capabilities()
  assert.equal(invalidResult.ok, false)
  if (!invalidResult.ok) assert.equal(invalidResult.error.code, 'client-protocol-error')

  const network = new SessionManagerApi(async () => { throw new Error('offline') })
  const networkResult = await network.capabilities()
  assert.equal(networkResult.ok, false)
  if (!networkResult.ok) assert.equal(networkResult.error.details?.cause, 'offline')
})

test('client API bounds hung capabilities requests with a visible timeout result', async () => {
  const hung = new SessionManagerApi((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }), 10)
  const started = Date.now()
  const result = await hung.capabilities()
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error.message, /超时/)
  assert.ok(Date.now() - started < 1_000)
})
