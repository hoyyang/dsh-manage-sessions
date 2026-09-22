import type { ApiError, ContextBreakdownView, ContextPressureView, SessionInfo, SessionStatsView, TokenUsageView } from './wire.ts'

export type ManagerTab = 'active' | 'archived'

/** Structural mirror of the official client-runtime SessionSummary. */
export interface CanonicalSessionSummary {
  id: string
  title?: string
  displayTitle: string
  cwd?: string
  parentId?: string
  origin?: 'subagent'
  running: boolean
  blank: boolean
  updatedAt: number
  projectionValues?: Readonly<Record<string, unknown>>
}

/** Structural subset of the official SessionListState consumed by this plugin. */
export interface CanonicalSessionList {
  ids: string[]
  byId: Record<string, CanonicalSessionSummary>
  current?: string
  phase: 'pending' | 'ready'
}

/** Structural mirror of the official WorkspaceView. */
export interface CanonicalWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface SessionGroup {
  id: string
  title: string
  path: string | null
  sessions: SessionInfo[]
}

/** Exact ordinary-session visibility rule used by the official homepage. */
export function sessionVisible(session: CanonicalSessionSummary, current: string | undefined, archived: ReadonlySet<string>): boolean {
  return session.origin !== 'subagent' && !archived.has(session.id) && (!session.blank || session.id === current)
}

/** Exact homepage session label source: blank sentinel, otherwise runtime displayTitle. */
export function canonicalTitle(session: CanonicalSessionSummary, blankTitle = 'New Session'): string {
  return session.blank ? blankTitle : session.displayTitle
}

/** UI rows preserve the exact official runtime title; only a missing title falls back. */
export function displayTitle(session: Pick<SessionInfo, 'id' | 'title'>): string {
  return session.title === null ? session.id : session.title
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function statsView(value: unknown): SessionStatsView | null {
  const row = object(value)
  if (row === null) return null
  const keys = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const
  if (!keys.every((key) => finite(row[key]) !== null)) return null
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as unknown as SessionStatsView
}

function tokenView(value: unknown): TokenUsageView | null {
  const row = object(value)
  if (row === null) return null
  const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
  if (!keys.every((key) => finite(row[key]) !== null)) return null
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as unknown as TokenUsageView
}

function pressureView(value: unknown): ContextPressureView | null {
  const row = object(value)
  if (row === null) return null
  const result: ContextPressureView = {}
  for (const key of ['pressureTokens', 'projectedTokens', 'contextWindow'] as const) {
    const number = finite(row[key])
    if (number !== null) result[key] = number
  }
  return Object.keys(result).length === 0 ? null : result
}

function breakdownView(value: unknown): ContextBreakdownView | null {
  const row = object(value)
  if (row === null) return null
  const keys = ['systemTokens', 'toolsTokens', 'messageTokens'] as const
  if (!keys.every((key) => finite(row[key]) !== null)) return null
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as unknown as ContextBreakdownView
}

/**
 * Merge canonical live metadata with optional host-only enrichment. Membership,
 * title, running state, cwd and updatedAt always come from the official feed.
 */
export function sessionInfoOf(summary: CanonicalSessionSummary, archived: boolean, blankTitle = 'New Session'): SessionInfo {
  const projections = summary.projectionValues ?? {}
  const stats = statsView(projections.sessionStats)
  return {
    id: summary.id,
    title: canonicalTitle(summary, blankTitle),
    status: summary.running ? 'running' : 'cold',
    running: summary.running,
    createdAt: null,
    updatedAt: summary.updatedAt,
    cwd: summary.cwd ?? null,
    parent: summary.parentId ?? null,
    subagent: summary.origin === 'subagent',
    delegationDepth: 0,
    archived,
    archiveTime: null,
    agentWorkMs: stats === null ? null : stats.llmMs + stats.toolMs,
    stats,
    tokenUsage: tokenView(projections.tokenUsage),
    contextPressure: pressureView(projections.contextPressure),
    contextBreakdown: breakdownView(projections.contextBreakdown),
  }
}

/**
 * Derive groups from the same SessionListState + WorkspaceListState owners as
 * the homepage. Official runtime projections provide row metrics; the retained
 * host catalog compatibility route is not a client data source.
 */
export function canonicalGroups(
  list: CanonicalSessionList,
  workspaces: readonly CanonicalWorkspace[],
  archivedSessionIds: readonly string[],
  tab: ManagerTab,
  blankTitle = 'New Session',
  ungroupedTitle = 'Ungrouped',
): SessionGroup[] {
  const archived = new Set(archivedSessionIds)
  const accounted = new Set<string>()
  const groups: SessionGroup[] = []
  const include = (summary: CanonicalSessionSummary): boolean => tab === 'active'
    ? sessionVisible(summary, list.current, archived)
    : summary.origin !== 'subagent' && archived.has(summary.id)

  for (const workspace of workspaces) {
    const sessions: SessionInfo[] = []
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id]
      if (summary === undefined) continue
      accounted.add(id)
      if (!include(summary)) continue
      sessions.push(sessionInfoOf(summary, tab === 'archived', blankTitle))
    }
    groups.push({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessions })
  }

  const stray = list.ids
    .map((id) => list.byId[id])
    .filter((summary): summary is CanonicalSessionSummary => summary !== undefined && !accounted.has(summary.id) && include(summary))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .map((summary) => sessionInfoOf(summary, tab === 'archived', blankTitle))
  if (stray.length > 0) groups.push({ id: '__orphans__', title: ungroupedTitle, path: null, sessions: stray })
  return groups
}

export function contextPercent(session: SessionInfo): number | null {
  const pressure = session.contextPressure
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const total = pressure?.contextWindow
  if (typeof used !== 'number' || typeof total !== 'number' || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.round((used / total) * 100))
}

export function blockerRows(error: ApiError | null): Array<{ id: string; status: string }> {
  const value = error?.details?.blockers
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    return typeof record.id === 'string' && typeof record.status === 'string' ? [{ id: record.id, status: record.status }] : []
  })
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'cold': return '未运行'
    case 'idle': return '空闲'
    case 'running': return '运行中'
    case 'attached-legacy': return '旧版运行实例（无法安全接管）'
    case 'config-identity': return '配置绑定（重启会重建）'
    case 'deletion-reserved': return '正在被其他删除事务处理'
    case 'disposal-failed': return '停止 Agent 失败'
    default: return status
  }
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '—'
}

export function formatDuration(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  const seconds = Math.round(value / 100) / 10
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const remain = Math.round(seconds % 60)
  return `${minutes}m ${remain}s`
}

export function formatInstant(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function archiveCapabilityMessage(capabilities: { archive: boolean; archiveBatch: boolean }, count: number): string | null {
  if (!capabilities.archive) return '当前宿主不支持归档操作'
  if (count > 1 && !capabilities.archiveBatch) return '当前宿主缺少批量归档回滚能力；请选择一个会话归档'
  return null
}
