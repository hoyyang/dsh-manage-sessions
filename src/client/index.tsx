import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { IconRefreshOutline16, IconTrashOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ManagerOverlay, type ManagerRuntimeProps } from './ManagerWindow.tsx'
import { getManagerAvailabilitySnapshot, mountManagerStore, openForceStop, openManager, openSingleDelete, subscribeManager } from './store.ts'
import { installSessionRowRename } from './row-rename.ts'
import { installWorkspaceCopyPath } from './workspace-copy.ts'
import { installManagerEntry } from './manager-entry.ts'
import { CSS, STYLE_OWNER } from './styles.ts'

const NS = 'dsh-manage-sessions'

export const REQUIRED_PRIMITIVES = [
  'Button',
  'StateDot',
  'Toast',
  'IconTrashOutline16',
  'IconCloseOutline16',
  'IconWarningOutline16',
  'IconArchiveOutline20',
  'IconChevronDownOutline14',
  'IconChevronRightOutline14',
  'IconLoadingOutline16',
  'IconRefreshOutline16',
  'IconDownloadOutline16',
  'IconInspectOutline12',
  'Tooltip',
] as const

/** Framework session kit share handed to `conversation.session.header.actions` occupants. */
interface HeaderActionKitProps {
  sessionId: string
  useSessions: <T>(selector: (state: {
    byId: Record<string, { displayTitle?: string } | undefined>
  }) => T) => T
}

interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: (props: never) => unknown): unknown
}

interface ClientContext {
  effect(callback: () => unknown | (() => void), label?: string): void
  slots: SlotsService
  get?(name: string): unknown
}

function RuntimeManagerOverlay(props: ManagerRuntimeProps) {
  useEffect(mountManagerStore, [])
  // Double-clicking a sidebar session row opens the SAME native rename dialog as
  // the row menu. The bridge drives the official menu path, so it owns no dialog
  // of its own; the label reader stays live across re-renders and the disposer
  // removes the listener with this overlay generation.
  const translateRef = useRef(props.t)
  translateRef.current = props.t
  useEffect(() => {
    const disposeRename = installSessionRowRename({ renameLabel: () => translateRef.current?.('rename') })
    // Workspace rows gain a third hover button that copies the workspace's
    // absolute path (catalog-matched); its disposer unmounts with this overlay.
    const disposeCopy = installWorkspaceCopyPath()
    // 会话管理 entry: header bridge beside the 工作区 label (v0.6.0 moved it
    // out of the sidebar footer); its disposer unmounts with this overlay.
    const disposeEntry = installManagerEntry({
      onOpen: (refocus) => openManager(refocus),
    })
    return () => {
      disposeRename()
      disposeCopy()
      disposeEntry()
    }
  }, [])
  return <><style data-plugin={STYLE_OWNER} data-plugin-css={NS}>{CSS}</style><ManagerOverlay {...props} /></>
}

export const name = NS
export const inject = ['slots']

function textTitle(value: ReactNode, id: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : `会话 ${id.slice(0, 8)}`
}

function HeaderDeleteAction(props: HeaderActionKitProps) {
  const overlayAvailable = useSyncExternalStore(subscribeManager, getManagerAvailabilitySnapshot, getManagerAvailabilitySnapshot)
  const row = props.useSessions((state) => state.byId[props.sessionId])
  if (!overlayAvailable) return null
  const title = typeof row?.displayTitle === 'string' && row.displayTitle !== ''
    ? row.displayTitle
    : textTitle(undefined, props.sessionId)
  return (
    <Tooltip label="删除会话" side="bottom" delayMs={400}>
      <button
        type="button"
        className="dsm-header-btn"
        aria-label="删除会话"
        onClick={(event) => {
          const button = event.currentTarget
          openSingleDelete(props.sessionId, title, () => { if (button.isConnected) button.focus() })
        }}
      >
        <IconTrashOutline16 size={15} />
      </button>
    </Tooltip>
  )
}

/** 强停·复活：官方 IconRefreshOutline16（重启箭头 = 强停后自动复活）。 */
function ForceResumeIcon() {
  return <IconRefreshOutline16 size={16} />
}

/** 强停·离线：纯电源符号（弧 + 竖线，无复合元素）。 */
function ForceOfflineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12.6 3.6a5.2 5.2 0 1 1-9.2 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 1.2v5.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** 强停会话分段组：一个容器、两个语义分区（⟳ 复活 / ⏻ 离线）。 */
function HeaderForceStopGroup(props: HeaderActionKitProps) {
  const overlayAvailable = useSyncExternalStore(subscribeManager, getManagerAvailabilitySnapshot, getManagerAvailabilitySnapshot)
  const row = props.useSessions((state) => state.byId[props.sessionId])
  if (!overlayAvailable) return null
  const title = typeof row?.displayTitle === 'string' && row.displayTitle !== ''
    ? row.displayTitle
    : textTitle(undefined, props.sessionId)
  return (
    <div className="dsm-force-group" role="group" aria-label="强停会话">
      <Tooltip label="强停会话 · 自动复活" side="bottom" delayMs={400}>
        <button
          type="button"
          className="dsm-force-seg dsm-force-seg-resume"
          aria-label="强停会话 · 自动复活"
          onClick={(event) => {
            const button = event.currentTarget
            openForceStop(props.sessionId, title, 'resume', () => { if (button.isConnected) button.focus() })
          }}
        >
          <ForceResumeIcon />
        </button>
      </Tooltip>
      <span className="dsm-force-divider" aria-hidden="true" />
      <Tooltip label="强停会话 · 停在离线" side="bottom" delayMs={400}>
        <button
          type="button"
          className="dsm-force-seg dsm-force-seg-offline"
          aria-label="强停会话 · 停在离线"
          onClick={(event) => {
            const button = event.currentTarget
            openForceStop(props.sessionId, title, 'offline', () => { if (button.isConnected) button.focus() })
          }}
        >
          <ForceOfflineIcon />
        </button>
      </Tooltip>
    </div>
  )
}

export function missingPrimitives(module: Record<string, unknown>): string[] {
  return REQUIRED_PRIMITIVES.filter((key) => module[key] === undefined)
}

export function apply(ctx: ClientContext): void {
  const missing = missingPrimitives(primitives as unknown as Record<string, unknown>)
  if (missing.length > 0) {
    console.warn(`[${NS}] host ui-primitives missing ${missing.join(', ')} — client disabled`)
    return
  }
  const sessions = ctx.get?.('sessions') as { refresh?: () => Promise<void> } | undefined
  const workspaces = ctx.get?.('workspaces') as { refresh?: () => Promise<void> } | undefined
  const Overlay = (props: ManagerRuntimeProps) => <RuntimeManagerOverlay
    {...props}
    refreshSessions={typeof sessions?.refresh === 'function' ? () => sessions.refresh!() : undefined}
    refreshWorkspaces={typeof workspaces?.refresh === 'function' ? () => workspaces.refresh!() : undefined}
  />
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: `${NS}:delete`,
    // Session log / Android 面板 sit at default order 0; 1 renders this to their right.
    order: 1,
  }, HeaderDeleteAction as unknown as (props: never) => unknown))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: `${NS}:force-stop`,
    // 0.5 lands immediately LEFT of the delete button (order 1), pushing the
    // default-order utilities (session log / Android panel / three-dot) further left.
    order: 0.5,
  }, HeaderForceStopGroup as unknown as (props: never) => unknown))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: NS,
    order: 100,
    locale: 'workspace',
  }, Overlay as unknown as (props: never) => unknown))
}
