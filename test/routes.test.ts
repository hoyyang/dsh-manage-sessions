import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionManagerService } from '../src/session-service.ts'
import {
  ARCHIVE_ROUTE, CAPABILITIES_ROUTE, CATALOG_ROUTE, DELETE_ROUTE, FORCE_STOP_ROUTE, UNARCHIVE_ROUTE, WORKSPACES_ROUTE,
  isLoopbackPeer, MAX_JSON_BODY_BYTES, mountSessionManagerRoutes,
  sameOriginHost, statusForError,
} from '../src/routes.ts'
import type { ApiResult, ArchiveSuccess, DeleteSuccess, WebRouteLike, WebServerLike } from '../src/types.ts'

class FakeWeb implements WebServerLike {
  readonly routes = new Map<string, WebRouteLike>()
  disposed: string[] = []
  failPath?: string
  register(route: WebRouteLike): () => void {
    if (route.path === this.failPath || this.routes.has(route.path)) throw new Error(`collision ${route.path}`)
    this.routes.set(route.path, route)
    return () => { if (this.routes.delete(route.path)) this.disposed.push(route.path) }
  }
}

interface Reply { status: number; headers: Record<string, string>; text: string }
function req(method: string, body = '', headers: Record<string, string> = {}, remote: string | undefined = '127.0.0.1'): IncomingMessage {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]) as IncomingMessage
  Object.defineProperties(stream, {
    method: { value: method, configurable: true },
    headers: { value: headers, configurable: true },
    socket: { value: { remoteAddress: remote }, configurable: true },
  })
  return stream
}
async function invoke(web: FakeWeb, path: string, request: IncomingMessage): Promise<Reply> {
  const reply: Reply = { status: 0, headers: {}, text: '' }
  const response = {
    writeHead(status: number, headers: Record<string, string>) { reply.status = status; reply.headers = headers; return this },
    end(value?: string) { reply.text = value ?? ''; return this },
  } as unknown as ServerResponse
  await web.routes.get(path)!.handler(request, response)
  return reply
}
function body(reply: Reply): any { return reply.text === '' ? undefined : JSON.parse(reply.text) }

function service(overrides: Partial<SessionManagerService> = {}): SessionManagerService {
  return {
    capabilities: { catalog: true, archive: true, archiveBatch: false, unarchiveAvailable: false, delete: true },
    async catalog() { return { ok: true, marker: 'catalog' } },
    async archive(): Promise<ApiResult<{ archivedIds: string[]; archiveTimes: Record<string, string>; alreadyArchivedIds: string[] }>> {
      return { ok: true, archivedIds: ['a'], archiveTimes: { a: '2026-01-01T00:00:00.000Z' }, alreadyArchivedIds: [] }
    },
    async unarchive(): Promise<ApiResult<{ unarchivedIds: string[]; alreadyActiveIds: string[]; archivedSessionIds: string[] }>> {
      return { ok: true, unarchivedIds: ['a'], alreadyActiveIds: [], archivedSessionIds: [] }
    },
    async delete(): Promise<ApiResult<{ deletedIds: string[] }>> { return { ok: true, deletedIds: ['a'] } },
    ...overrides,
  } as unknown as SessionManagerService
}
function mount(web: FakeWeb, svc = service()): () => void {
  return mountSessionManagerRoutes(web, svc, {
    version: 'test-version',
    state: { isReady: () => true, stateError: () => null },
    recovery: { found: false, action: 'none', restored: [], cleaned: [], deferred: [], warnings: [] },
  })
}

test('loopback and same-origin helpers enforce exact transport boundaries', () => {
  for (const value of ['127.0.0.1', '127.9.8.7', '::1', '::ffff:127.2.3.4']) assert.equal(isLoopbackPeer(value), true, value)
  for (const value of [undefined, '', '0.0.0.0', '192.0.2.1', '::ffff:192.0.2.1', '::2']) assert.equal(isLoopbackPeer(value), false, String(value))
  assert.equal(sameOriginHost({ headers: {} as IncomingMessage['headers'] }), true)
  assert.equal(sameOriginHost({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(sameOriginHost({ headers: { origin: 'HTTP://LOCALHOST:3080', host: 'localhost:3080' } }), true)
  assert.equal(sameOriginHost({ headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' } }), false)
  assert.equal(sameOriginHost({ headers: { origin: 'not a url', host: '127.0.0.1:3080' } }), false)
  assert.equal(sameOriginHost({ headers: { origin: 'http://localhost:3080' } }), false)
  assert.equal(statusForError('unknown-session'), 404)
  assert.equal(statusForError('blocked'), 409)
  assert.equal(statusForError('capability-missing'), 503)
  assert.equal(statusForError('staging-failed'), 500)
})

test('read routes gate peers and methods, map catalog faults, and implement HEAD', async () => {
  let catalogCalls = 0
  const web = new FakeWeb()
  mount(web, service({ async catalog() { catalogCalls++; return { ok: true, marker: 'catalog' } as never } }))
  const denied = await invoke(web, CATALOG_ROUTE, req('GET', '', {}, '192.0.2.7'))
  assert.equal(denied.status, 403)
  assert.equal(body(denied).error.code, 'forbidden')
  assert.equal(catalogCalls, 0)
  const wrong = await invoke(web, CATALOG_ROUTE, req('POST'))
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'GET, HEAD')
  const get = await invoke(web, CATALOG_ROUTE, req('GET'))
  assert.equal(get.status, 200)
  assert.equal(body(get).marker, 'catalog')
  const head = await invoke(web, CATALOG_ROUTE, req('HEAD'))
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.match(head.headers['content-type'], /application\/json/)
  assert.equal(head.headers['cache-control'], 'no-store')
  const caps = await invoke(web, CAPABILITIES_ROUTE, req('GET'))
  assert.equal(body(caps).version, 'test-version')
  assert.equal(body(caps).state.ready, true)
  assert.equal(body(caps).state.recovery.action, 'none')

  const broken = new FakeWeb()
  mount(broken, service({ async catalog() { throw new Error('catalog-boom') } }))
  const failed = await invoke(broken, CATALOG_ROUTE, req('GET'))
  assert.equal(failed.status, 500)
  assert.equal(body(failed).error.code, 'catalog-failed')
  assert.equal(body(failed).error.details.cause, 'catalog-boom')
})

test('mutation routes enforce origin/body limits and map ApiResult status', async () => {
  const seen: unknown[][] = []
  const web = new FakeWeb()
  const resultById: Record<string, ApiResult<ArchiveSuccess>> = {
    unknown: { ok: false, error: { code: 'unknown-session', message: 'unknown' } },
    blocked: { ok: false, error: { code: 'blocked', message: 'blocked' } },
    missing: { ok: false, error: { code: 'capability-missing', message: 'missing' } },
    broken: { ok: false, error: { code: 'persistence-failed', message: 'broken' } },
  }
  mount(web, service({
    async archive(ids: readonly unknown[]) {
      seen.push([...ids])
      return resultById[String(ids[0])] ?? { ok: true, archivedIds: ids.map(String), archiveTimes: {}, alreadyArchivedIds: [] }
    },
    async delete(ids: readonly unknown[]): Promise<ApiResult<DeleteSuccess>> {
      seen.push([...ids]); return { ok: true, deletedIds: ids.map(String), disposedIds: ids.map(String), pendingCleanup: [] }
    },
  }))
  const same = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }
  const valid = await invoke(web, ARCHIVE_ROUTE, req('POST', JSON.stringify({ ids: ['a'] }), same))
  assert.equal(valid.status, 200)
  assert.deepEqual(seen[0], ['a'])
  const deleted = await invoke(web, DELETE_ROUTE, req('POST', JSON.stringify({ ids: ['d'] })))
  assert.equal(deleted.status, 200)
  assert.deepEqual(seen[1], ['d'])

  for (const [payload, expected] of [['', 400], ['{', 400], ['[]', 400], ['null', 400], ['"text"', 400]] as const) {
    assert.equal((await invoke(web, ARCHIVE_ROUTE, req('POST', payload, same))).status, expected)
  }
  const tooLarge = JSON.stringify({ ids: ['x'.repeat(MAX_JSON_BODY_BYTES)] })
  assert.equal((await invoke(web, ARCHIVE_ROUTE, req('POST', tooLarge, same))).status, 413)
  assert.equal((await invoke(web, ARCHIVE_ROUTE, req('POST', '{"ids":["a"]}', { origin: 'http://evil.test', host: '127.0.0.1:3080' }))).status, 403)
  const restore = await invoke(web, UNARCHIVE_ROUTE, req('POST', JSON.stringify({ ids: ['a'] }), same))
  assert.equal(restore.status, 200)
  assert.deepEqual(body(restore).unarchivedIds, ['a'])

  for (const [id, status] of [['unknown', 404], ['blocked', 409], ['missing', 503], ['broken', 500]] as const) {
    assert.equal((await invoke(web, ARCHIVE_ROUTE, req('POST', JSON.stringify({ ids: [id] }), same))).status, status)
  }
})

test('mount disposer is idempotent and registration collision rolls back', () => {
  const web = new FakeWeb()
  const dispose = mount(web)
  assert.deepEqual([...web.routes.keys()], [CATALOG_ROUTE, WORKSPACES_ROUTE, CAPABILITIES_ROUTE, ARCHIVE_ROUTE, UNARCHIVE_ROUTE, DELETE_ROUTE, FORCE_STOP_ROUTE])
  dispose(); dispose()
  assert.equal(web.routes.size, 0)
  assert.equal(web.disposed.length, 7)

  const colliding = new FakeWeb()
  colliding.failPath = ARCHIVE_ROUTE
  assert.throws(() => mount(colliding), /collision/)
  assert.equal(colliding.routes.size, 0)
  assert.deepEqual(colliding.disposed, [CAPABILITIES_ROUTE, WORKSPACES_ROUTE, CATALOG_ROUTE])
})

test('workspaces route serves registry metadata without a session scan', async () => {
  const web = new FakeWeb()
  mount(web, service({
    async workspaceList() {
      return { ok: true as const, workspaces: [{ id: 'w1', title: 'dsh', path: '/srv/dsh' }] }
    },
  }))
  const denied = await invoke(web, WORKSPACES_ROUTE, req('GET', '', {}, '192.0.2.7'))
  assert.equal(denied.status, 403)
  const wrong = await invoke(web, WORKSPACES_ROUTE, req('POST'))
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'GET, HEAD')
  const get = await invoke(web, WORKSPACES_ROUTE, req('GET'))
  assert.equal(get.status, 200)
  assert.deepEqual(body(get).workspaces, [{ id: 'w1', title: 'dsh', path: '/srv/dsh' }])
  const head = await invoke(web, WORKSPACES_ROUTE, req('HEAD'))
  assert.equal(head.status, 200)
  assert.equal(head.text, '')

  const blocked = new FakeWeb()
  mount(blocked, service({
    async workspaceList() {
      return { ok: false as const, error: { code: 'capability-missing' as const, message: 'workspace listing is unavailable on this host' } }
    },
  }))
  const failed = await invoke(blocked, WORKSPACES_ROUTE, req('GET'))
  assert.equal(failed.status, 503)
  assert.equal(body(failed).error.code, 'capability-missing')
})
