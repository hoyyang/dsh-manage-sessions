/**
 * HTTP transport surface for dsh-manage-sessions (host half).
 *
 * Every route enforces two hard gates before any handler logic:
 *  - loopback peer only (`127.0.0.0/8`, `::1`, `::ffff:127.x`) — a missing or
 *    non-loopback socket peer is answered with 403 before anything runs;
 *  - mutation POSTs additionally require same-origin when the browser sends
 *    `Origin` (its URL-parsed host must equal the request Host, normalized);
 *    Origin-less loopback callers (curl/scripts) are permitted.
 *
 * Transport rules: wrong method → 405 + `allow`; too-large JSON → 413 (the
 * request is paused, never destroyed, so the response can never race a
 * socket teardown); empty/malformed/non-object JSON → 400. Every response is
 * `application/json` + `cache-control: no-store` and uses the structured
 * `{ok:false,error:{code,message,details?}}` error shape.
 * Semantics live in SessionManagerService — routes only translate.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { SessionManagerService } from './session-service.ts'
import type { ApiErrorCode, ApiResult, RecoveryReport, WebRouteLike, WebServerLike } from './types.ts'

export const CATALOG_ROUTE = '/dsh-manage-sessions/catalog'
export const WORKSPACES_ROUTE = '/dsh-manage-sessions/workspaces'
export const CAPABILITIES_ROUTE = '/dsh-manage-sessions/capabilities'
export const ARCHIVE_ROUTE = '/dsh-manage-sessions/archive'
export const UNARCHIVE_ROUTE = '/dsh-manage-sessions/unarchive'
export const DELETE_ROUTE = '/dsh-manage-sessions/delete'
export const FORCE_STOP_ROUTE = '/dsh-manage-sessions/force-stop'

/** Body budget for the mutation routes. */
export const MAX_JSON_BODY_BYTES = 64 * 1024

/** Transport-level error codes (one level below the transaction vocabulary). */
export type TransportErrorCode = ApiErrorCode | 'forbidden' | 'method-not-allowed'

/** Runtime feedback the capabilities route surfaces for clients. */
export interface RouteFeedback {
  version: string
  state: { isReady(): boolean; stateError(): string | null }
  recovery: RecoveryReport | null
}

interface TransportErrorBody<C extends TransportErrorCode = TransportErrorCode> {
  ok: false
  error: { code: C; message: string; details?: Record<string, unknown> }
}

interface PlannedResponse {
  status: number
  body?: unknown
}

/**
 * Accept only loopback peers: `127.0.0.0/8`, `::1`, and the IPv4-mapped
 * `::ffff:127.x`. A missing `remoteAddress` is never loopback.
 */
export function isLoopbackPeer(remote: string | undefined): boolean {
  if (remote === undefined || remote === '') return false
  if (remote === '::1') return true
  if (isIP(remote) === 6) {
    const mapped = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(remote)
    return mapped !== null && Number(mapped[1]) === 127
  }
  return isIP(remote) === 4 && remote.startsWith('127.')
}

/**
 * Browser mutations must come from the exact host the request was sent to.
 * Absent `Origin` (curl, scripts, same-process tooling) is permitted — the
 * loopback-peer gate above already constrained who can reach the route.
 */
export function sameOriginHost(request: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string' || host.trim() === '') return false
  try {
    return new URL(origin).host.trim().toLowerCase() === host.trim().toLowerCase()
  } catch {
    return false
  }
}

/** Sensible HTTP status for every transaction-level ApiErrorCode. */
export function statusForError(code: ApiErrorCode): number {
  switch (code) {
    case 'invalid-request':
    case 'invalid-body':
    case 'empty-batch':
      return 400
    case 'body-too-large':
      return 413
    case 'unknown-session':
    case 'artifact-not-locatable':
      return 404
    case 'blocked':
      return 409
    case 'capability-missing':
      return 503
    default:
      // storage/commit/internal failures (staging, journal, archive-times,
      // disposal, catalog, persistence, …) are the host's problem, not the
      // request's: they surface as 500.
      return 500
  }
}

/**
 * Mount all six exact routes. Returns the disposer that removes every
 * registered route; a registration failure disposes the routes mounted so
 * far before rethrowing, so a collision never leaks a half-mounted surface.
 */
export function mountSessionManagerRoutes(
  webServer: WebServerLike,
  service: SessionManagerService,
  feedback: RouteFeedback,
): () => void {
  const disposers: Array<() => void> = []
  const register = (path: string, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): void => {
    try {
      disposers.push(webServer.register({ kind: 'exact', path, handler } satisfies WebRouteLike))
    } catch (error) {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // best-effort rollback of an already-failed mount
        }
      }
      throw error
    }
  }

  register(CATALOG_ROUTE, jsonRoute(async () => {
    try {
      return { status: 200, body: await service.catalog() }
    } catch (error) {
      return { status: 500, body: transportError('catalog-failed', 'session catalog read failed', { cause: messageOf(error) }) }
    }
  }, { methods: ['GET', 'HEAD'], allow: 'GET, HEAD' }))

  register(WORKSPACES_ROUTE, jsonRoute(async () => mapped(await guarded(() => service.workspaceList())), { methods: ['GET', 'HEAD'], allow: 'GET, HEAD' }))

  register(CAPABILITIES_ROUTE, jsonRoute(async () => ({
    status: 200,
    body: {
      ok: true,
      capabilities: service.capabilities,
      version: feedback.version,
      state: {
        ready: feedback.state.isReady(),
        error: feedback.state.stateError(),
        recovery: feedback.recovery,
      },
    },
  }), { methods: ['GET', 'HEAD'], allow: 'GET, HEAD' }))

  register(ARCHIVE_ROUTE, jsonRoute(async (body) => {
    return mapped(await guarded(() => service.archive(idsOf(body))))
  }, { methods: ['POST'], allow: 'POST', mutation: true }))

  register(UNARCHIVE_ROUTE, jsonRoute(async (body) => {
    return mapped(await guarded(() => service.unarchive(idsOf(body))))
  }, { methods: ['POST'], allow: 'POST', mutation: true }))

  register(DELETE_ROUTE, jsonRoute(async (body) => {
    return mapped(await guarded(() => service.delete(idsOf(body))))
  }, { methods: ['POST'], allow: 'POST', mutation: true }))

  register(FORCE_STOP_ROUTE, jsonRoute(async (body) => {
    return mapped(await guarded(() => service.forceStop(body.id, body.mode)))
  }, { methods: ['POST'], allow: 'POST', mutation: true }))

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.splice(0).reverse()) dispose()
  }
}

// ---------------------------------------------------------------------------
// Per-route wrapper: transport gates, then the handler
// ---------------------------------------------------------------------------

interface RouteOptions {
  methods: readonly string[]
  allow: string
  mutation?: boolean
}

function jsonRoute(
  run: (body: Record<string, unknown>, request: IncomingMessage) => Promise<PlannedResponse>,
  options: RouteOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { mutation = false } = options
  return async (request, response) => {
    const remote = request.socket?.remoteAddress
    if (!isLoopbackPeer(remote)) {
      sendJson(response, 403, transportError('forbidden', 'this route only serves loopback peers', { remote: remote ?? 'unknown' }))
      return
    }
    const method = typeof request.method === 'string' ? request.method : ''
    if (!options.methods.includes(method)) {
      sendJson(response, 405, transportError('method-not-allowed', `method ${method === '' ? '(unknown)' : method} is not allowed`, { allowed: options.allow }), { allow: options.allow })
      return
    }
    let body: Record<string, unknown> = {}
    if (mutation) {
      if (!sameOriginHost(request)) {
        sendJson(response, 403, transportError('forbidden', 'cross-origin mutation requests are rejected'))
        return
      }
      const read = await readJsonBody(request)
      if (read.error === 'too-large') {
        sendJson(response, 413, transportError('body-too-large', `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`))
        return
      }
      if (read.error !== null) {
        sendJson(response, 400, transportError('invalid-body', read.error === 'empty' ? 'request body is empty' : 'request body is not a single JSON object'))
        return
      }
      body = read.value
    }
    let planned: PlannedResponse
    try {
      planned = await run(body, request)
    } catch (error) {
      // The service layer returns ApiResult instead of throwing; a raw
      // propagation here is a routing bug and must still answer 500.
      planned = { status: 500, body: transportError('route-error', 'internal route failure', { cause: messageOf(error) }) }
    }
    if (method === 'HEAD') sendJson(response, planned.status)
    else sendJson(response, planned.status, planned.body)
  }
}

function idsOf(body: Record<string, unknown>): readonly unknown[] {
  // Missing/non-array ids are passed to the service verbatim: normalizeIds
  // turns them into `invalid-request`, keeping validation in one place.
  return body.ids as readonly unknown[]
}

async function guarded<T extends object>(run: () => Promise<ApiResult<T>>): Promise<ApiResult<T> | TransportErrorBody<ApiErrorCode>> {
  try {
    return await run()
  } catch (error) {
    return transportError('route-error', 'internal route failure', { cause: messageOf(error) })
  }
}

function mapped<T extends object>(result: ApiResult<T> | TransportErrorBody<ApiErrorCode>): PlannedResponse {
  return result.ok ? { status: 200, body: result } : { status: statusForError(result.error.code), body: result }
}

// ---------------------------------------------------------------------------
// Body reading (never destroys the request — no response/teardown race)
// ---------------------------------------------------------------------------

type BodyRead = { error: null; value: Record<string, unknown> } | { error: 'empty' | 'malformed' | 'too-large' }

function readJsonBody(request: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (result: BodyRead): void => {
      if (settled) return
      settled = true
      if (result.error === 'too-large') request.pause() // stop buffering; the socket is left to the server
      resolve(result)
    }
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        settle({ error: 'too-large' })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        settle({ error: 'empty' })
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        settle({ error: 'malformed' })
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        settle({ error: 'malformed' })
        return
      }
      settle({ error: null, value: parsed as Record<string, unknown> })
    })
    request.on('error', () => settle({ error: 'malformed' }))
    request.on('aborted', () => settle({ error: 'malformed' }))
  })
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function sendJson(response: ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  // HEAD gets the exact headers of a GET, with no body.
  if (body === undefined) response.end()
  else response.end(JSON.stringify(body))
}

function transportError<C extends TransportErrorCode>(code: C, message: string, details?: Record<string, unknown>): TransportErrorBody<C> {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
