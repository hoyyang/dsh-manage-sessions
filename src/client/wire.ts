export type SessionStatus = 'cold' | 'idle' | 'running' | 'attached-legacy' | 'config-identity' | 'deletion-reserved' | 'unknown'

export interface SessionStatsView {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

export interface TokenUsageView {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ContextPressureView {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface ContextBreakdownView {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

export interface SessionInfo {
  id: string
  status: SessionStatus
  running: boolean
  createdAt: number | null
  updatedAt: number | null
  cwd: string | null
  parent: string | null
  subagent: boolean
  delegationDepth: number
  archived: boolean
  archiveTime: string | null
  agentWorkMs: number | null
  title: string | null
  stats: SessionStatsView | null
  tokenUsage: TokenUsageView | null
  contextPressure: ContextPressureView | null
  contextBreakdown: ContextBreakdownView | null
}

export interface HostCapabilities {
  catalog: boolean
  disposalStatus: boolean
  disposeBatch: boolean
  archive: boolean
  archiveBatch: boolean
  unarchiveAvailable: boolean
  delete: boolean
  stateReady: boolean
  projectionsLive: boolean
  projectionsCold: boolean
  forceStop: boolean
  forceStopResume: boolean
}

export interface ApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export type ApiResult<T extends object> = ({ ok: true } & T) | { ok: false; error: ApiError }

export interface ArchiveSuccess {
  archivedIds: string[]
  archiveTimes: Record<string, string>
  alreadyArchivedIds: string[]
}

export interface UnarchiveSuccess {
  unarchivedIds: string[]
  alreadyActiveIds: string[]
  archivedSessionIds: string[]
}

export interface CapabilitiesPayload {
  ok: true
  capabilities: HostCapabilities
  version: string
}

export interface DeleteSuccess {
  deletedIds: string[]
  disposedIds: string[]
  pendingCleanup: string[]
}

export type ForceStopMode = 'resume' | 'offline'

export interface ForceStopSuccess {
  id: string
  mode: ForceStopMode
  stoppedVia: 'not-running' | 'cancel' | 'phase-reset'
  attached: boolean
  resumed: boolean
  inboxAtStop: number | null
  elapsedMs: number
  trace: string[]
}
