import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Button,
  IconArchiveOutline20,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconDownloadOutline16,
  IconInspectOutline12,
  IconLoadingOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  StateDot,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionManagerApi } from './api.ts'
import {
  archiveCapabilityMessage,
  blockerRows,
  canonicalGroups,
  contextPercent,
  displayTitle,
  formatCount,
  formatDuration,
  formatInstant,
  statusLabel,
  type CanonicalSessionList,
  type CanonicalWorkspace,
  type ManagerTab,
  type SessionGroup,
} from './model.ts'
import { closeManager, getManagerSnapshot, subscribeManager } from './store.ts'
import type { ApiError, ForceStopMode, ForceStopSuccess, HostCapabilities, SessionInfo } from './wire.ts'

const api = new SessionManagerApi()
const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),[href],[tabindex]:not([tabindex="-1"])'

type Mutation = { action: 'archive' | 'delete'; ids: string[]; labels: string[] }
type CompletedAction = Mutation['action'] | 'restore'
type SelectorHook<T> = <Slice>(selector: (state: T) => Slice) => Slice

interface WorkspaceSnapshot {
  items: readonly CanonicalWorkspace[]
  archivedSessionIds: readonly string[]
  state: 'idle' | 'loading' | 'error'
  /** 0.1.5 replaced the rc.8 `baselinesReady` flag with this lifecycle phase. */
  phase: 'pending' | 'ready'
  error: { message?: string } | null
}

export interface ManagerRuntimeProps {
  useSessions: SelectorHook<CanonicalSessionList>
  useWorkspaces: SelectorHook<WorkspaceSnapshot>
  t?: (key: string, params?: Record<string, unknown>) => string
  refreshSessions?: () => Promise<void>
  refreshWorkspaces?: () => Promise<void>
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(query).matches)
  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return
    const media = globalThis.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

function useFocusTrap(open: boolean, root: RefObject<HTMLElement | null>, onClose: () => void, disabled = false, focusScope?: string): void {
  const focusScopeRef = useRef(focusScope)
  focusScopeRef.current = focusScope
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const activeRoot = () => focusScopeRef.current === undefined ? root.current : root.current?.querySelector<HTMLElement>(focusScopeRef.current) ?? null
    const focusFirst = () => activeRoot()?.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const timer = globalThis.setTimeout(focusFirst, 0)
    const onFocus = (event: FocusEvent) => {
      const currentRoot = activeRoot()
      if (currentRoot !== null && event.target instanceof Node && !currentRoot.contains(event.target)) focusFirst()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !disabled) {
        event.preventDefault()
        onClose()
        return
      }
      const currentRoot = activeRoot()
      if (event.key !== 'Tab' || currentRoot === null) return
      const elements = [...currentRoot.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null)
      if (elements.length === 0) return
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      globalThis.clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
      if (previous?.isConnected === true) previous.focus()
    }
  }, [disabled, onClose, open, root])
}

function DialogFrame(props: { children: ReactNode; labelledBy: string; describedBy?: string; className: string; active?: boolean; busy?: boolean; focusScope?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const active = props.active !== false
  useFocusTrap(active, ref, props.onClose, props.busy, props.focusScope)
  return (
    <div className="dsm-overlay" aria-hidden={active ? undefined : true}>
      <div className="dsm-mask" aria-hidden="true" onClick={props.busy || !active ? undefined : props.onClose} />
      <div ref={ref} className={props.className} role="dialog" aria-modal={active ? 'true' : undefined} aria-labelledby={props.labelledBy} aria-describedby={props.describedBy} aria-busy={props.busy || undefined}>
        {props.children}
      </div>
    </div>
  )
}

function ConfirmDialog(props: {
  mutation: Mutation
  busy: boolean
  error: ApiError | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const destructive = props.mutation.action === 'delete'
  const [acknowledged, setAcknowledged] = useState(false)
  const blockers = blockerRows(props.error)
  const count = props.mutation.ids.length
  const title = destructive ? `永久删除 ${count} 个会话？` : `归档 ${count} 个会话？`
  return (
    <DialogFrame className="dsm-confirm" labelledBy="dsm-confirm-title" describedBy="dsm-confirm-description" busy={props.busy} onClose={props.onCancel}>
      <div className="dsm-confirm-icon"><IconWarningOutline16 size={20} /></div>
      <h2 id="dsm-confirm-title">{title}</h2>
      <p id="dsm-confirm-description">{destructive
        ? '此操作会永久移除所选会话的本地持久化目录，无法撤销。不会级联删除子会话或共享附件。'
        : '所选会话将移入「已归档会话」，之后可以恢复活跃。'}</p>
      <div className="dsm-confirm-ids">{props.mutation.labels.slice(0, 8).map((label, index) => <div key={props.mutation.ids[index]}>{label} · {props.mutation.ids[index]}</div>)}{count > 8 && <div>以及另外 {count - 8} 个会话</div>}</div>
      {destructive && (
        <label className="dsm-ack">
          <input type="checkbox" name="confirm-permanent-delete" checked={acknowledged} disabled={props.busy} onChange={(event) => setAcknowledged(event.currentTarget.checked)} />
          <span>我了解这些会话将被永久删除，且无法恢复。</span>
        </label>
      )}
      {props.error !== null && (
        <div className="dsm-feedback" data-kind="error" role="alert">
          <strong>{props.error.message}</strong>
          {blockers.length > 0 && <ul className="dsm-blockers">{blockers.map((item) => <li key={item.id}><code>{item.id}</code> — {statusLabel(item.status)}</li>)}</ul>}
        </div>
      )}
      <div className="dsm-actions">
        <Button variant="outline" type="button" disabled={props.busy} onClick={props.onCancel}>取消</Button>
        <Button className={destructive ? 'dsm-danger-fill' : ''} variant="primary" type="button" disabled={props.busy || (destructive && !acknowledged)} onClick={props.onConfirm}>
          {props.busy ? <><IconLoadingOutline16 className="dsm-spinner" /> 处理中…</> : destructive ? '永久删除' : '确认归档'}
        </Button>
      </div>
    </DialogFrame>
  )
}

function DetailSection(props: { title: string; children: ReactNode }) {
  return <section className="dsm-detail-section"><h4>{props.title}</h4><dl className="dsm-facts">{props.children}</dl></section>
}

function SessionDetail(props: { session: SessionInfo | null; canRestore: boolean; busy: boolean; onRestore: (id: string) => void; onClose: () => void }) {
  const session = props.session
  if (session === null) return <div className="dsm-detail-empty"><IconInspectOutline12 size={20} /><strong>选择“查看详情”</strong><span>会话状态、上下文与 Token 指标会显示在这里。</span></div>
  const percent = contextPercent(session)
  const stats = session.stats
  const tokens = session.tokenUsage
  const context = session.contextPressure
  const breakdown = session.contextBreakdown
  const level = percent === null ? 'none' : percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'normal'
  return (
    <div className="dsm-detail-content">
      <div className="dsm-detail-head">
        <div className="dsm-detail-heading"><span className="dsm-detail-kicker">会话详情</span><h3>{displayTitle(session)}</h3><span className="dsm-status-line"><StateDot state={session.running ? 'ongoing' : 'done'} size={7} />{statusLabel(session.status)}</span></div>
        <Button className="dsm-detail-close" variant="ghost" size="sm" type="button" aria-label="返回会话列表" onClick={props.onClose}><span className="dsm-detail-close-label">返回列表</span><IconCloseOutline16 /></Button>
      </div>
      <div className="dsm-mono">{session.id}</div>
      {session.archived && <Button className="dsm-detail-restore" variant="outline" size="sm" icon={<IconDownloadOutline16 />} disabled={!props.canRestore || props.busy} onClick={() => props.onRestore(session.id)}>恢复活跃</Button>}
      <div className="dsm-context-card" data-level={level}>
        <div className="dsm-context-card-head"><span>上下文窗口使用率</span><strong>{percent === null ? '—' : `${percent}%`}</strong></div>
        <div className="dsm-progress" role="progressbar" aria-label="上下文窗口使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, percent)}><span style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></div>
        <div className="dsm-context-values">已用 {formatCount(context?.projectedTokens ?? context?.pressureTokens)} / 容量 {formatCount(context?.contextWindow)} tokens</div>
      </div>

      <DetailSection title="时间与状态">
        <dt>状态</dt><dd>{statusLabel(session.status)}</dd>
        <dt>最近活动</dt><dd>{formatInstant(session.updatedAt)}</dd>
        <dt>Agent 工作时间</dt><dd>{formatDuration(session.agentWorkMs)}</dd>
      </DetailSection>
      <DetailSection title="执行统计">
        <dt>轮次 / 步骤</dt><dd>{formatCount(stats?.turns)} / {formatCount(stats?.steps)}</dd>
        <dt>模型 / 工具耗时</dt><dd>{formatDuration(stats?.llmMs)} / {formatDuration(stats?.toolMs)}</dd>
        <dt>首 Token 延迟</dt><dd>{formatDuration(stats?.ttftMs)}（{formatCount(stats?.ttftSteps)} 步）</dd>
        <dt>解码</dt><dd>{formatDuration(stats?.decodeMs)} / {formatCount(stats?.decodeTokens)} tokens</dd>
      </DetailSection>
      <DetailSection title="Token 使用">
        <dt>输入 / 输出</dt><dd>{formatCount(tokens?.uncachedInputTokens)} / {formatCount(tokens?.outputTokens)}</dd>
        <dt>缓存读取 / 写入</dt><dd>{formatCount(tokens?.cacheReadTokens)} / {formatCount(tokens?.cacheWriteTokens)}</dd>
        <dt>系统 / 工具 / 消息</dt><dd>{formatCount(breakdown?.systemTokens)} / {formatCount(breakdown?.toolsTokens)} / {formatCount(breakdown?.messageTokens)}</dd>
      </DetailSection>
      <DetailSection title="来源">
        <dt>工作目录</dt><dd className="dsm-mono-value">{session.cwd ?? '—'}</dd>
        <dt>父会话</dt><dd className="dsm-mono-value">{session.parent ?? '—'}</dd>
        <dt>类型</dt><dd>{session.subagent ? `子会话（深度 ${session.delegationDepth}）` : '普通会话'}</dd>
      </DetailSection>
    </div>
  )
}

function statusDot(status: string): 'done' | 'warning' | 'ongoing' | 'error' {
  if (status === 'running') return 'ongoing'
  if (status === 'disposal-failed') return 'error'
  if (status === 'attached-legacy' || status === 'config-identity' || status === 'deletion-reserved') return 'warning'
  return 'done'
}

function SessionRow(props: {
  session: SessionInfo
  selected: boolean
  current: boolean
  busy: boolean
  archived: boolean
  canRestore: boolean
  onToggle: () => void
  onDetail: (trigger: HTMLElement) => void
  onRestore: () => void
}) {
  const percent = contextPercent(props.session)
  const pressure = props.session.contextPressure
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  const total = pressure?.contextWindow
  const level = percent === null ? 'none' : percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'normal'
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    if (!props.busy) props.onToggle()
  }
  return (
    <div className="dsm-row" role="group" aria-label={`${displayTitle(props.session)} 会话行；点击行可${props.selected ? '取消选择' : '选择'}`} data-selected={props.selected} data-current={props.current} tabIndex={props.busy ? -1 : 0} onKeyDown={onKeyDown} onClick={() => { if (!props.busy) props.onToggle() }}>
      <span className="dsm-check-cell" onClick={(event) => event.stopPropagation()}>
        <input className="dsm-check" type="checkbox" name={`select-session-${props.session.id}`} aria-label={`选择 ${displayTitle(props.session)}`} checked={props.selected} disabled={props.busy} onChange={props.onToggle} />
      </span>
      <span className="dsm-row-identity"><span className="dsm-row-title">{displayTitle(props.session)}</span><span className="dsm-row-meta"><span><StateDot state={statusDot(props.session.status)} size={6} />{statusLabel(props.session.status)}</span><span>最近活动 {formatInstant(props.session.updatedAt)}</span></span></span>
      <span className="dsm-row-context" data-level={level} title={percent === null ? '上下文使用率不可用' : `上下文窗口使用 ${percent}% · ${formatCount(used)} / ${formatCount(total)} tokens`}><span className="dsm-row-context-label">上下文 {percent === null ? '—' : `${percent}%`}</span><span className="dsm-mini-progress"><i style={{ width: `${Math.min(100, percent ?? 0)}%` }} /></span><small>{formatCount(used)} / {formatCount(total)}</small></span>
      <span className="dsm-row-actions" onClick={(event) => event.stopPropagation()}>
        {props.archived && <Button variant="ghost" size="sm" type="button" disabled={!props.canRestore || props.busy} onClick={props.onRestore}>恢复活跃</Button>}
        <Button variant="ghost" size="sm" type="button" icon={<IconInspectOutline12 />} disabled={props.busy} onClick={(event) => props.onDetail(event.currentTarget)}>查看详情</Button>
      </span>
    </div>
  )
}

function SessionGroupView(props: {
  group: SessionGroup
  expanded: boolean
  selected: Set<string>
  currentId: string | null
  busy: boolean
  archived: boolean
  canRestore: boolean
  onToggleGroup: () => void
  onToggleSelect: (id: string) => void
  onSelectGroup: (ids: string[]) => void
  onClearGroup: (ids: string[]) => void
  onCurrent: (id: string, trigger: HTMLElement) => void
  onRestore: (ids: string[]) => void
}) {
  const ids = props.group.sessions.map((session) => session.id)
  const selectedCount = ids.filter((id) => props.selected.has(id)).length
  const allSelected = ids.length > 0 && selectedCount === ids.length
  const partial = selectedCount > 0 && !allSelected
  const checkbox = useRef<HTMLInputElement>(null)
  useEffect(() => { if (checkbox.current !== null) checkbox.current.indeterminate = partial }, [partial])
  return (
    <section className="dsm-group">
      <div className="dsm-group-head">
        <label className="dsm-group-check-cell">
          <input ref={checkbox} className="dsm-check" type="checkbox" name={`select-group-${props.group.id}`} aria-label={`选择工作区 ${props.group.title}`} aria-checked={partial ? 'mixed' : allSelected} checked={allSelected} disabled={ids.length === 0 || props.busy} onChange={() => allSelected ? props.onClearGroup(ids) : props.onSelectGroup(ids)} />
        </label>
        <button className="dsm-group-toggle" type="button" aria-expanded={props.expanded} disabled={props.busy} onClick={props.onToggleGroup}>
          {props.expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          <span className="dsm-group-title"><span className="dsm-group-name">{props.group.title}</span>{props.group.path !== null && <span className="dsm-group-path">{props.group.path}</span>}</span>
        </button>
        <span className="dsm-group-count">{ids.length} 个会话</span>
        {selectedCount > 0 && <span className="dsm-group-selected">已选 {selectedCount}/{ids.length}</span>}
        <Button variant="ghost" size="sm" type="button" disabled={ids.length === 0 || allSelected || props.busy} onClick={() => props.onSelectGroup(ids)}>全选</Button>
        <Button variant="ghost" size="sm" type="button" disabled={selectedCount === 0 || props.busy} onClick={() => props.onClearGroup(ids)}>取消全选</Button>
      </div>
      {props.expanded && <div className="dsm-group-rows">{props.group.sessions.length === 0
        ? <div className="dsm-group-empty">此工作区暂无{props.archived ? '已归档' : '活跃'}会话</div>
        : props.group.sessions.map((session) => <SessionRow key={session.id} session={session} selected={props.selected.has(session.id)} current={session.id === props.currentId} busy={props.busy} archived={props.archived} canRestore={props.canRestore} onToggle={() => props.onToggleSelect(session.id)} onDetail={(trigger) => props.onCurrent(session.id, trigger)} onRestore={() => props.onRestore([session.id])} />)}
      </div>}
    </section>
  )
}

const FORCE_STOP_VIA_LABEL: Record<ForceStopSuccess['stoppedVia'], string> = {
  'not-running': '会话当前没有运行中的活动',
  cancel: '已发送中止信号并确认停止',
  'phase-reset': '中止信号未收敛，已强制复位运行状态',
}

function ForceStopDialog(props: { id: string; title: string; mode: ForceStopMode; refreshSessions?: () => Promise<void> }) {
  const resume = props.mode === 'resume'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [outcome, setOutcome] = useState<ForceStopSuccess | null>(null)
  const execute = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await api.forceStop(props.id, props.mode)
    if (!result.ok) { setError(result.error); setBusy(false); return }
    setOutcome(result)
    setBusy(false)
    if (props.refreshSessions !== undefined) void props.refreshSessions().catch(() => {})
  }
  return (
    <DialogFrame className="dsm-confirm" labelledBy="dsm-force-title" describedBy="dsm-force-description" busy={busy} onClose={closeManager}>
      <div className="dsm-confirm-icon" style={{ color: resume ? 'var(--dsw-alias-brand-primary,#4d6bfe)' : undefined }}>
        <IconWarningOutline16 size={20} />
      </div>
      <h2 id="dsm-force-title">{resume ? '强停并自动复活会话？' : '强停会话并停在离线？'}</h2>
      <p id="dsm-force-description">
        {resume
          ? '将中止该会话卡住的活动，保留排队消息，并确保会话恢复在线继续处理。'
          : '将中止该会话卡住的活动并让其停在线下：排队中的内存消息会被放弃（已写入日志的历史保留），之后你发消息即可重新唤起。'}
      </p>
      <div className="dsm-confirm-ids">{props.title} · {props.id}</div>
      {outcome !== null && (
        <div className="dsm-force-outcome" role="status">
          <span><strong>{FORCE_STOP_VIA_LABEL[outcome.stoppedVia]}</strong>（{(outcome.elapsedMs / 1000).toFixed(1)}s）</span>
          <span>模式：{outcome.mode === 'resume' ? '自动复活' : '停在离线'} · 会话{outcome.attached ? '在线' : '离线'}{outcome.mode === 'resume' ? (outcome.resumed ? ' · 将继续处理排队消息' : '') : ' · 不会自动恢复'}</span>
          {outcome.inboxAtStop !== null && <span>停止时排队消息：<b>{outcome.inboxAtStop}</b> 条</span>}
          {outcome.trace.length > 1 && <span>升级路径：<code>{outcome.trace.join(' → ')}</code></span>}
        </div>
      )}
      {error !== null && (
        <div className="dsm-feedback" data-kind="error" role="alert">
          <strong>{error.message}</strong>
          {error.details?.trace !== undefined && <div className="dsm-force-outcome"><span>升级路径：<code>{String(error.details.trace)}</code></span></div>}
        </div>
      )}
      <div className="dsm-actions">
        <Button variant="outline" type="button" disabled={busy} onClick={closeManager}>{outcome !== null ? '关闭' : '取消'}</Button>
        {outcome === null && (
          <Button className={resume ? '' : 'dsm-danger-fill'} variant="primary" type="button" disabled={busy} onClick={() => void execute()}>
            {busy ? <><IconLoadingOutline16 className="dsm-spinner" /> 强制停止中…</> : resume ? '强停并复活' : '强停并停在线下'}
          </Button>
        )}
      </div>
    </DialogFrame>
  )
}

function managerError(message: string): ApiError {
  return { code: 'client-state-sync-error', message }
}

function transportOutcomeIsIndeterminate(error: ApiError): boolean {
  return error.code === 'client-protocol-error'
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function ManagerDialog(props: ManagerRuntimeProps) {
  const list = props.useSessions((state) => state)
  const workspaceState = props.useWorkspaces((state) => state)
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null)
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [tab, setTab] = useState<ManagerTab>('active')
  const [selected, setSelected] = useState<Record<ManagerTab, Set<string>>>(() => ({ active: new Set(), archived: new Set() }))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const detailRef = useRef<HTMLElement>(null)
  const detailTriggerRef = useRef<HTMLElement | null>(null)
  const mobileDetail = useMediaQuery('(max-width: 720px)')
  const [mutation, setMutation] = useState<Mutation | null>(null)
  const [mutationError, setMutationError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ key: number; text: string } | null>(null)
  const capabilitiesControllerRef = useRef<AbortController | null>(null)
  const archiveIdsRef = useRef<readonly string[]>(workspaceState.archivedSessionIds)
  const listRef = useRef<CanonicalSessionList>(list)
  const knownGroupsRef = useRef<Set<string>>(new Set())

  useEffect(() => { archiveIdsRef.current = workspaceState.archivedSessionIds }, [workspaceState.archivedSessionIds])
  useEffect(() => { listRef.current = list }, [list])

  const loadCapabilities = useCallback(async () => {
    capabilitiesControllerRef.current?.abort()
    const controller = new AbortController()
    capabilitiesControllerRef.current = controller
    setCapabilitiesLoading(true)
    setLoadError(null)
    try {
      const result = await api.capabilities(controller.signal)
      if (result.ok) setCapabilities(result.capabilities)
      else setLoadError(result.error)
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(managerError(error instanceof Error ? error.message : String(error)))
    } finally {
      if (capabilitiesControllerRef.current === controller) {
        capabilitiesControllerRef.current = null
        setCapabilitiesLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadCapabilities()
    return () => { capabilitiesControllerRef.current?.abort(); capabilitiesControllerRef.current = null }
  }, [loadCapabilities])

  const blankTitle = props.t?.('session.new') ?? 'New Session'
  const ungroupedTitle = props.t?.('group.ungrouped') ?? 'Ungrouped'
  const groups = useMemo(() => canonicalGroups(list, workspaceState.items, workspaceState.archivedSessionIds, tab, blankTitle, ungroupedTitle), [blankTitle, list, tab, ungroupedTitle, workspaceState.archivedSessionIds, workspaceState.items])
  const sessions = useMemo(() => groups.flatMap((group) => group.sessions), [groups])
  const activeGroups = useMemo(() => canonicalGroups(list, workspaceState.items, workspaceState.archivedSessionIds, 'active', blankTitle, ungroupedTitle), [blankTitle, list, ungroupedTitle, workspaceState.archivedSessionIds, workspaceState.items])
  const archivedGroups = useMemo(() => canonicalGroups(list, workspaceState.items, workspaceState.archivedSessionIds, 'archived', blankTitle, ungroupedTitle), [blankTitle, list, ungroupedTitle, workspaceState.archivedSessionIds, workspaceState.items])
  const activeCount = activeGroups.reduce((count, group) => count + group.sessions.length, 0)
  const archivedCount = archivedGroups.reduce((count, group) => count + group.sessions.length, 0)
  const selectedNow = selected[tab]
  const selectedSessions = sessions.filter((session) => selectedNow.has(session.id))
  const current = sessions.find((session) => session.id === currentId) ?? null
  const canDelete = capabilities?.delete === true
  const canRestore = capabilities?.unarchiveAvailable === true
  const archiveGap = capabilitiesLoading
    ? '正在检查宿主能力'
    : capabilities === null
      ? '宿主能力检查失败，请刷新重试'
      : archiveCapabilityMessage(capabilities, selectedNow.size)

  const openDetail = (id: string, trigger: HTMLElement) => {
    detailTriggerRef.current = trigger
    if (mobileDetail) trigger.blur()
    setCurrentId(id)
  }
  const restoreDetailFocus = useCallback(() => {
    const trigger = detailTriggerRef.current
    detailTriggerRef.current = null
    if (!mobileDetail || trigger === null) return
    globalThis.setTimeout(() => {
      if (trigger?.isConnected === true) trigger.focus()
      else document.querySelector<HTMLElement>(`#dsm-tab-${tab}`)?.focus()
    }, 0)
  }, [mobileDetail, tab])
  const closeDetail = () => {
    restoreDetailFocus()
    setCurrentId(null)
  }

  useEffect(() => {
    const allKeys = [...activeGroups.map((group) => `${group.id}:active`), ...archivedGroups.map((group) => `${group.id}:archived`)]
    const known = new Set(allKeys)
    setExpanded((prior) => {
      const next = new Set([...prior].filter((key) => known.has(key)))
      for (const key of allKeys) if (!knownGroupsRef.current.has(key)) next.add(key)
      return next
    })
    knownGroupsRef.current = known
  }, [activeGroups, archivedGroups])

  useEffect(() => {
    if (list.phase !== 'ready' || workspaceState.phase !== 'ready') return
    const activeIds = new Set(activeGroups.flatMap((group) => group.sessions.map((session) => session.id)))
    const archivedIds = new Set(archivedGroups.flatMap((group) => group.sessions.map((session) => session.id)))
    setSelected((prior) => {
      const active = new Set([...prior.active].filter((id) => activeIds.has(id)))
      const archived = new Set([...prior.archived].filter((id) => archivedIds.has(id)))
      if (sameSet(active, prior.active) && sameSet(archived, prior.archived)) return prior
      return { active, archived }
    })
    if (currentId !== null && !activeIds.has(currentId) && !archivedIds.has(currentId)) { restoreDetailFocus(); setCurrentId(null) }
  }, [activeGroups, archivedGroups, currentId, list.phase, restoreDetailFocus, workspaceState.phase])

  useEffect(() => {
    if (!mobileDetail || current === null) return
    const timer = globalThis.setTimeout(() => detailRef.current?.querySelector<HTMLElement>('.dsm-detail-close')?.focus(), 0)
    return () => globalThis.clearTimeout(timer)
  }, [current, mobileDetail])

  const mirrorHasSettled = (action: CompletedAction, ids: readonly string[]) => {
    const archived = new Set(archiveIdsRef.current)
    if (action === 'archive') return ids.every((id) => archived.has(id))
    if (action === 'restore') return ids.every((id) => !archived.has(id))
    return ids.every((id) => listRef.current.byId[id] === undefined)
  }
  const waitForMirror = async (action: CompletedAction, ids: readonly string[], timeoutMs = 4_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (mirrorHasSettled(action, ids)) return true
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 40))
    }
    return mirrorHasSettled(action, ids)
  }
  const ensureMirror = async (action: CompletedAction, ids: readonly string[], timeoutMs = 4_000): Promise<boolean> => {
    if (mirrorHasSettled(action, ids)) return true
    const refresh = action === 'delete' ? props.refreshSessions : props.refreshWorkspaces
    if (refresh !== undefined) void refresh().catch(() => { /* bounded mirror wait reports synchronization failure */ })
    return await waitForMirror(action, ids, timeoutMs)
  }

  const finishSuccess = (action: CompletedAction, ids: readonly string[]) => {
    const labels: Record<CompletedAction, string> = { archive: '已归档', restore: '已恢复活跃', delete: '已永久删除' }
    setToast({ key: Date.now(), text: `${labels[action]} ${ids.length} 个会话` })
    setSelected((prior) => ({
      active: new Set([...prior.active].filter((id) => !ids.includes(id))),
      archived: new Set([...prior.archived].filter((id) => !ids.includes(id))),
    }))
    restoreDetailFocus()
    setCurrentId(null)
  }

  const executeConfirmed = async () => {
    if (mutation === null || busy) return
    setBusy(true)
    setMutationError(null)
    const action = mutation.action
    const ids = mutation.ids
    const result = action === 'archive' ? await api.archive(ids) : await api.delete(ids)
    if (!result.ok) {
      if (transportOutcomeIsIndeterminate(result.error) && await ensureMirror(action, ids, 12_000)) {
        setMutation(null)
        finishSuccess(action, ids)
      } else setMutationError(result.error)
      setBusy(false)
      return
    }
    setMutation(null)
    if (!await ensureMirror(action, ids)) {
      setLoadError(managerError('操作已由服务器提交，但官方会话列表同步超时。请点击刷新后确认状态。'))
    } else finishSuccess(action, ids)
    setBusy(false)
  }

  const restore = async (ids: string[]) => {
    if (busy || ids.length === 0 || !canRestore) return
    setBusy(true)
    setLoadError(null)
    const result = await api.unarchive(ids)
    if (!result.ok) {
      if (transportOutcomeIsIndeterminate(result.error) && await ensureMirror('restore', ids, 12_000)) finishSuccess('restore', ids)
      else setLoadError(result.error)
      setBusy(false)
      return
    }
    if (!await ensureMirror('restore', ids)) setLoadError(managerError('恢复已由服务器提交，但官方工作区同步超时。请点击刷新后确认状态。'))
    else finishSuccess('restore', ids)
    setBusy(false)
  }

  const refreshAll = async () => {
    try { await Promise.all([props.refreshSessions?.(), props.refreshWorkspaces?.(), loadCapabilities()]) }
    catch (error) { setLoadError(managerError(error instanceof Error ? error.message : String(error))) }
  }
  const changeTab = (next: ManagerTab) => { detailTriggerRef.current = null; setTab(next); setCurrentId(null) }
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next: ManagerTab = tab === 'active' ? 'archived' : 'active'
    changeTab(next)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'active' ? 0 : 1]?.focus()
  }
  const toggleSelected = (id: string) => setSelected((prior) => {
    const next = new Set(prior[tab])
    if (next.has(id)) next.delete(id); else next.add(id)
    return { ...prior, [tab]: next }
  })
  const selectIds = (ids: string[]) => setSelected((prior) => ({ ...prior, [tab]: new Set([...prior[tab], ...ids]) }))
  const clearIds = (ids: string[]) => setSelected((prior) => { const next = new Set(prior[tab]); ids.forEach((id) => next.delete(id)); return { ...prior, [tab]: next } })
  const selectAll = () => selectIds(sessions.map((session) => session.id))
  const selectNone = () => setSelected((prior) => ({ ...prior, [tab]: new Set() }))
  const ask = (action: Mutation['action']) => {
    setMutationError(null)
    setMutation({ action, ids: selectedSessions.map((session) => session.id), labels: selectedSessions.map(displayTitle) })
  }
  const baselineLoading = list.phase !== 'ready' || workspaceState.phase !== 'ready'
  const workspaceError = workspaceState.state === 'error' ? workspaceState.error?.message ?? '官方工作区数据加载失败' : null

  return (
    <>
      <DialogFrame className="dsm-window" labelledBy="dsm-title" describedBy="dsm-subtitle" active={mutation === null} busy={busy} focusScope={mobileDetail && current !== null ? '.dsm-detail' : undefined} onClose={closeManager}>
        <header className="dsm-head">
          <div className="dsm-head-mark"><IconArchiveOutline20 size={20} /></div>
          <div className="dsm-head-copy"><h2 id="dsm-title" className="dsm-title">会话管理</h2><p id="dsm-subtitle" className="dsm-subtitle">按工作区查看、归档、恢复或删除会话</p></div>
          <button className="dsm-icon-btn" type="button" aria-label="刷新官方会话数据" disabled={capabilitiesLoading || busy} onClick={() => void refreshAll()}>{capabilitiesLoading ? <IconLoadingOutline16 className="dsm-spinner" /> : <IconRefreshOutline16 />}</button>
          <button className="dsm-icon-btn" type="button" aria-label="关闭会话管理" disabled={busy} onClick={closeManager}><IconCloseOutline16 /></button>
        </header>
        <div className="dsm-tabs" role="tablist" aria-label="会话状态">
          <button id="dsm-tab-active" className="dsm-tab" role="tab" aria-controls="dsm-session-panel" aria-selected={tab === 'active'} tabIndex={tab === 'active' ? 0 : -1} disabled={busy} onKeyDown={onTabKeyDown} onClick={() => changeTab('active')}><span>活跃会话</span><b>{activeCount} 个会话</b></button>
          <button id="dsm-tab-archived" className="dsm-tab" role="tab" aria-controls="dsm-session-panel" aria-selected={tab === 'archived'} tabIndex={tab === 'archived' ? 0 : -1} disabled={busy} onKeyDown={onTabKeyDown} onClick={() => changeTab('archived')}><span>已归档会话</span><b>{archivedCount} 个会话</b></button>
        </div>
        <div className="dsm-toolbar">
          <div className="dsm-toolbar-actions">
            {tab === 'active' && <Button variant="outline" size="sm" icon={<IconArchiveOutline20 size={15} />} title={archiveGap ?? undefined} disabled={selectedNow.size === 0 || archiveGap !== null || busy} onClick={() => ask('archive')}>归档</Button>}
            {tab === 'archived' && <Button variant="outline" size="sm" icon={<IconDownloadOutline16 />} title={canRestore ? undefined : '当前宿主不支持恢复活跃'} disabled={selectedNow.size === 0 || !canRestore || busy} onClick={() => void restore(selectedSessions.map((session) => session.id))}>恢复活跃</Button>}
            <Button className="dsm-danger-button" variant="outline" size="sm" icon={<IconTrashOutline16 />} title={canDelete ? undefined : '当前宿主不支持永久删除'} disabled={selectedNow.size === 0 || !canDelete || busy} onClick={() => ask('delete')}>永久删除</Button>
          </div>
          <span className="dsm-toolbar-spacer" />
          <span className="dsm-selection" aria-live="polite">已选择 <strong>{selectedNow.size}</strong> / 共 {sessions.length} 个会话</span>
          <Button variant="ghost" size="sm" disabled={sessions.length === 0 || selectedNow.size === sessions.length || busy} onClick={selectAll}>全选</Button>
          <Button variant="ghost" size="sm" disabled={selectedNow.size === 0 || busy} onClick={selectNone}>取消全选</Button>
        </div>
        {(loadError !== null || workspaceError !== null) && <div className="dsm-feedback dsm-window-feedback" data-kind="error" role="alert">{workspaceError ?? loadError?.message}</div>}
        <main id="dsm-session-panel" className="dsm-main" role="tabpanel" aria-labelledby={tab === 'active' ? 'dsm-tab-active' : 'dsm-tab-archived'}>
          <div className="dsm-list" aria-hidden={mobileDetail && current !== null ? true : undefined} {...(mobileDetail && current !== null ? { inert: '' } : {})}>
            {baselineLoading ? <div className="dsm-state"><IconLoadingOutline16 className="dsm-spinner" /><strong>正在同步官方工作区…</strong><span>这不会等待历史指标扫描。</span></div>
              : groups.length === 0 ? <div className="dsm-state"><strong>{tab === 'active' ? '没有活跃会话' : '没有已归档会话'}</strong><span>{tab === 'active' ? '新建会话后会显示在这里。' : '归档后的会话会显示在这里。'}</span></div>
                : groups.map((group) => {
                  const key = `${group.id}:${tab}`
                  return <SessionGroupView key={key} group={group} expanded={expanded.has(key)} selected={selectedNow} currentId={currentId} busy={busy} archived={tab === 'archived'} canRestore={canRestore} onToggleGroup={() => setExpanded((prior) => { const next = new Set(prior); if (next.has(key)) next.delete(key); else next.add(key); return next })} onToggleSelect={toggleSelected} onSelectGroup={selectIds} onClearGroup={clearIds} onCurrent={openDetail} onRestore={(ids) => void restore(ids)} />
                })}
          </div>
          <aside ref={detailRef} className="dsm-detail" data-open={current !== null} aria-hidden={mobileDetail && current === null ? true : undefined} {...(mobileDetail && current === null ? { inert: '' } : {})}><SessionDetail session={current} canRestore={canRestore} busy={busy} onRestore={(id) => void restore([id])} onClose={closeDetail} /></aside>
        </main>
        <footer className="dsm-footer"><span>{busy ? <><IconLoadingOutline16 className="dsm-spinner" /> 正在确认官方状态…</> : '列表来源：DSH 官方实时会话状态'}</span><span>共 {sessions.length} 个会话</span></footer>
      </DialogFrame>
      {mutation !== null && <ConfirmDialog mutation={mutation} busy={busy} error={mutationError} onCancel={() => { if (!busy) { setMutation(null); setMutationError(null) } }} onConfirm={() => void executeConfirmed()} />}
      {toast !== null && <Toast key={toast.key} text={toast.text} onDone={() => setToast(null)} />}
    </>
  )
}

function SingleDeleteDialog(props: { id: string; title: string; useSessions: SelectorHook<CanonicalSessionList>; refreshSessions?: () => Promise<void> }) {
  const list = props.useSessions((state) => state)
  const listRef = useRef(list)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const mutation = useMemo<Mutation>(() => ({ action: 'delete', ids: [props.id], labels: [props.title] }), [props.id, props.title])
  useEffect(() => { listRef.current = list }, [list])
  const waitForRemoval = async (): Promise<boolean> => {
    if (listRef.current.byId[props.id] === undefined) return true
    if (props.refreshSessions !== undefined) void props.refreshSessions().catch(() => {})
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      if (listRef.current.byId[props.id] === undefined) return true
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 40))
    }
    return listRef.current.byId[props.id] === undefined
  }
  const execute = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await api.delete([props.id])
    if (!result.ok) {
      if (transportOutcomeIsIndeterminate(result.error) && await waitForRemoval()) closeManager()
      else { setError(result.error); setBusy(false) }
      return
    }
    if (await waitForRemoval()) closeManager()
    else { setError(managerError('删除已由服务器提交，但官方会话列表同步超时。请关闭后刷新页面确认状态。')); setBusy(false) }
  }
  return <ConfirmDialog mutation={mutation} busy={busy} error={error} onCancel={closeManager} onConfirm={() => void execute()} />
}

export function ManagerOverlay(props: ManagerRuntimeProps) {
  const state = useSyncExternalStore(subscribeManager, getManagerSnapshot, getManagerSnapshot)
  if (!state.open || state.intent === null) return null
  if (state.intent.kind === 'delete') return <SingleDeleteDialog key={state.revision} id={state.intent.id} title={state.intent.title} useSessions={props.useSessions} refreshSessions={props.refreshSessions} />
  if (state.intent.kind === 'force-stop') return <ForceStopDialog key={state.revision} id={state.intent.id} title={state.intent.title} mode={state.intent.mode} refreshSessions={props.refreshSessions} />
  return <ManagerDialog key={state.revision} {...props} />
}
