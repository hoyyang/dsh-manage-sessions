import type { ForceStopMode } from './wire.ts'

export interface SingleDeleteIntent {
  kind: 'delete'
  id: string
  title: string
}

export interface ManagerIntent {
  kind: 'manager'
}

export interface ForceStopIntent {
  kind: 'force-stop'
  id: string
  title: string
  mode: ForceStopMode
}

export type OpenIntent = ManagerIntent | SingleDeleteIntent | ForceStopIntent

export interface ManagerUiState {
  open: boolean
  revision: number
  intent: OpenIntent | null
}

interface ManagerStoreOwner {
  state: ManagerUiState
  returnFocus: (() => void) | null
  listeners: Set<() => void>
  mounts: number
}

const STORE_KEY = '__dshSessionManagerUiStore__' as const
const root = globalThis as typeof globalThis & { [STORE_KEY]?: ManagerStoreOwner }
const owner = root[STORE_KEY] ??= {
  state: { open: false, revision: 0, intent: null },
  returnFocus: null,
  listeners: new Set(),
  mounts: 0,
}
owner.mounts ??= 0

function emit(): void {
  for (const listener of [...owner.listeners]) listener()
}

function rememberFocus(restoreFocus?: (() => void) | null): void {
  if (restoreFocus !== undefined) {
    owner.returnFocus = restoreFocus
    return
  }
  const candidate = document.activeElement instanceof HTMLElement ? document.activeElement : null
  owner.returnFocus = candidate?.isConnected === true ? () => { if (candidate.isConnected) candidate.focus() } : null
}

export function openManager(restoreFocus?: (() => void) | null): void {
  rememberFocus(restoreFocus)
  owner.state = { open: true, revision: owner.state.revision + 1, intent: { kind: 'manager' } }
  emit()
}

export function openSingleDelete(id: string, title: string, restoreFocus?: (() => void) | null): void {
  rememberFocus(restoreFocus)
  owner.state = { open: true, revision: owner.state.revision + 1, intent: { kind: 'delete', id, title } }
  emit()
}

export function openForceStop(id: string, title: string, mode: ForceStopMode, restoreFocus?: (() => void) | null): void {
  rememberFocus(restoreFocus)
  owner.state = { open: true, revision: owner.state.revision + 1, intent: { kind: 'force-stop', id, title, mode } }
  emit()
}

export function closeManager(): void {
  if (!owner.state.open) return
  owner.state = { open: false, revision: owner.state.revision + 1, intent: null }
  emit()
  const restore = owner.returnFocus
  owner.returnFocus = null
  queueMicrotask(() => {
    try { restore?.() } catch { /* the owner may have unmounted with its row */ }
  })
}

export function subscribeManager(listener: () => void): () => void {
  owner.listeners.add(listener)
  return () => { owner.listeners.delete(listener) }
}

export function getManagerSnapshot(): ManagerUiState {
  return owner.state
}

export function getManagerAvailabilitySnapshot(): boolean {
  return owner.mounts > 0
}

/** Tie the global HMR-stable store to mounted overlay owners; full unload cleans it. */
export function mountManagerStore(): () => void {
  owner.mounts += 1
  emit()
  let active = true
  return () => {
    if (!active) return
    active = false
    owner.mounts = Math.max(0, owner.mounts - 1)
    if (owner.mounts === 0) resetManagerStore()
    else emit()
  }
}

/** Reset transient intent without destroying subscriptions owned by other slots. */
export function resetManagerStore(): void {
  owner.state = { open: false, revision: owner.state.revision + 1, intent: null }
  owner.returnFocus = null
  emit()
}
