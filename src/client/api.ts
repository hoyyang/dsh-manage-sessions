import type { ApiResult, ArchiveSuccess, CapabilitiesPayload, DeleteSuccess, ForceStopMode, ForceStopSuccess, UnarchiveSuccess } from './wire.ts'

export const CAPABILITIES_URL = '/dsh-manage-sessions/capabilities'
export const ARCHIVE_URL = '/dsh-manage-sessions/archive'
export const UNARCHIVE_URL = '/dsh-manage-sessions/unarchive'
export const DELETE_URL = '/dsh-manage-sessions/delete'
export const FORCE_STOP_URL = '/dsh-manage-sessions/force-stop'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function protocolFailure(message: string, details?: Record<string, unknown>): ApiResult<never> {
  return { ok: false, error: { code: 'client-protocol-error', message, details } }
}

async function decode<T extends object>(response: Response): Promise<ApiResult<T>> {
  let body: unknown
  try { body = await response.json() } catch {
    return protocolFailure('服务器返回了无法解析的响应', { status: response.status })
  }
  if (!isObject(body) || typeof body.ok !== 'boolean') {
    return protocolFailure('服务器响应缺少结果标记', { status: response.status })
  }
  if (body.ok) {
    if (!response.ok) return protocolFailure('服务器状态与响应内容不一致', { status: response.status })
    return body as unknown as ApiResult<T>
  }
  const error = body.error
  if (!isObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
    return protocolFailure('服务器错误响应结构无效', { status: response.status })
  }
  return body as unknown as ApiResult<T>
}

export class SessionManagerApi {
  constructor(
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly timeoutMs = 8_000,
  ) {}

  capabilities(signal?: AbortSignal): Promise<ApiResult<CapabilitiesPayload>> {
    return this.get<CapabilitiesPayload>(CAPABILITIES_URL, signal)
  }

  archive(ids: readonly string[], signal?: AbortSignal): Promise<ApiResult<ArchiveSuccess>> {
    return this.mutate<ArchiveSuccess>(ARCHIVE_URL, ids, signal)
  }

  unarchive(ids: readonly string[], signal?: AbortSignal): Promise<ApiResult<UnarchiveSuccess>> {
    return this.mutate<UnarchiveSuccess>(UNARCHIVE_URL, ids, signal)
  }

  delete(ids: readonly string[], signal?: AbortSignal): Promise<ApiResult<DeleteSuccess>> {
    return this.mutate<DeleteSuccess>(DELETE_URL, ids, signal)
  }

  private async get<T extends object>(url: string, signal?: AbortSignal): Promise<ApiResult<T>> {
    return this.request<T>(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    }, signal)
  }

  private mutate<T extends object>(url: string, ids: readonly string[], signal?: AbortSignal): Promise<ApiResult<T>> {
    return this.request<T>(url, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }, signal)
  }

  forceStop(id: string, mode: ForceStopMode, signal?: AbortSignal): Promise<ApiResult<ForceStopSuccess>> {
    // Escalation (cancel → dispose → phase reset) can legitimately poll for ~9s
    // before settling; budget far beyond the default 8s request timeout.
    return this.request<ForceStopSuccess>(FORCE_STOP_URL, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, mode }),
    }, signal, 35_000)
  }

  private async request<T extends object>(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs?: number): Promise<ApiResult<T>> {
    const timeout = new AbortController()
    const abort = () => timeout.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = globalThis.setTimeout(() => timeout.abort(new DOMException('request timed out', 'TimeoutError')), timeoutMs ?? this.timeoutMs)
    try {
      const response = await this.fetcher(url, { ...init, signal: timeout.signal })
      return await decode<T>(response)
    } catch (error) {
      if (signal?.aborted) throw error
      const timedOut = timeout.signal.aborted && timeout.signal.reason instanceof DOMException && timeout.signal.reason.name === 'TimeoutError'
      return protocolFailure(timedOut ? '会话管理服务响应超时，请重试' : '无法连接会话管理服务', {
        cause: error instanceof Error ? error.message : String(error),
      })
    } finally {
      globalThis.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}
