/**
 * Copy-workspace-path button for the official sidebar workspace rows.
 *
 * The official workspace row (DSH 0.1.5 dsh-client-ui-workspace) renders a
 * hover-only rowActions span holding exactly two buttons — the overflow menu
 * and the + new-session button — and its dwell HoverCard already shows the
 * workspace directory path without offering a way to copy it. This module
 * appends a third, same-style button that copies the workspace's absolute
 * path to the clipboard.
 *
 * Scope contract (user-approved design card, v0.5.0):
 *  - the button lands immediately LEFT of the two native buttons. React owns
 *    the span's children, so the node is APPENDED (never inserted) and pulled
 *    visually first with CSS order: -1 — a foreign trailing node is the one
 *    position React's index-based reconciliation provably ignores;
 *  - same-style means the native sibling's own class string, cloned at
 *    augmentation time, so hover reveal and theming stay byte-identical;
 *  - only real workspace rows qualify: [role=treeitem][aria-expanded] without
 *    aria-selected, whose rowActions span holds exactly two buttons. The
 *    ungrouped bucket (no path, one button) is untouched;
 *  - the path comes from the plugin's existing catalog route
 *    (GET /dsh-manage-sessions/catalog -> workspaces[{title, path}]),
 *    matched by the row's displayed title. Titles are unique by host rename
 *    contract; a failed match is reported by name, never guessed;
 *  - every lookup is structural and locale-tolerant. Dead ends warn once, by
 *    name, and leave the page untouched.
 *
 * The disposer removes every injected button, the observer and the toast, so
 * unmounting restores the untouched native behavior.
 */

/** Minimal structural DOM surface — keeps the module unit-testable without a DOM. */
export interface ElementLike {
  closest(selector: string): ElementLike | null
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  querySelector(selector: string): ElementLike | null
  querySelectorAll(selector: string): ArrayLike<ElementLike>
  appendChild(child: ElementLike): void
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  remove(): void
  isConnected?: boolean
  textContent?: string | null
}

export interface CopyDocumentLike {
  createElement(tag: string): ElementLike & { innerHTML?: string }
  querySelector(selector: string): ElementLike | null
  querySelectorAll(selector: string): ArrayLike<ElementLike>
  /** Attachment point for the toast; document.body on the live page. */
  body?: ElementLike | null
  addEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
  removeEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
}

/** Slice of the plugin catalog route the bridge consumes. */
export interface CatalogWorkspace {
  title: string
  path: string
}

export type CatalogResult =
  | { ok: true; workspaces: CatalogWorkspace[] }
  | { ok: false; message: string }

export interface WorkspaceCopyOptions {
  /** Document to observe; defaults to the live browser document. */
  document?: CopyDocumentLike
  /** Catalog source; defaults to the plugin's GET /dsh-manage-sessions/catalog. */
  fetchCatalog?: () => Promise<CatalogResult>
  /** Clipboard sink; defaults to navigator.clipboard with a legacy fallback. */
  copyText?: (text: string) => Promise<void>
  /** Diagnostic sink; defaults to console.warn with the plugin prefix. */
  warn?: (message: string) => void
  /** Schedule helper; defaults to requestAnimationFrame with a timer fallback. */
  schedule?: (run: () => void) => void
  /** DOM observer hookup; defaults to a MutationObserver on the document root. */
  observe?: (run: () => void) => () => void
  /** Monotonic clock for the catalog cache; defaults to Date.now. */
  now?: () => number
  /** Success flash duration on the button. */
  copiedMs?: number
  /** Toast auto-hide delay. */
  toastMs?: number
  /** Error toast auto-hide delay. */
  toastErrorMs?: number
}

export const COPY_BUTTON_MARKER = 'data-dsm-copy'
const ROW_SELECTOR = '[role="treeitem"]'
const ROW_SELECTOR_EXPANDED = '[role="treeitem"][aria-expanded]'
const ACTIONS_SELECTOR = '[class*="rowActions"]'
const TOAST_ID = 'dsm-copy-toast'
/** Registry-only metadata route: no session scans, answers in milliseconds. */
const WORKSPACES_URL = '/dsh-manage-sessions/workspaces'
/** Legacy heavyweight fallback (full session scan) for older hosts. */
const CATALOG_URL = '/dsh-manage-sessions/catalog'
/** Hover-prefetched cache: a click inside the TTL copies without any request. */
const CACHE_TTL_MS = 60000

const NS = 'dsh-manage-sessions'

/** Folder + stacked copy-sheets glyph, official dsh-client-ui-primitives glyph. */
export const COPY_ICON_SVG =
  "<svg class=\"dsm-copy-ico\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z\" fill=\"currentColor\"/></svg>"

export const CHECK_ICON_SVG =
  "<svg class=\"dsm-copy-check\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><path d=\"M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z\" fill=\"currentColor\"/></svg>"
/**
 * The workspace row a target belongs to, or null: workspace rows carry
 * aria-expanded and never aria-selected (session rows are the reverse).
 */
export function workspaceRowFor(target: ElementLike | null | undefined): ElementLike | null {
  if (target === null || target === undefined || typeof target.closest !== 'function') return null
  const row = target.closest(ROW_SELECTOR)
  if (row === null) return null
  if (!row.hasAttribute('aria-expanded')) return null
  if (row.hasAttribute('aria-selected')) return null
  return row
}

/** Exact title match against the registry; titles are unique by host contract. */
export function matchWorkspace(
  title: string,
  workspaces: readonly CatalogWorkspace[],
): CatalogWorkspace | undefined {
  const needle = title.trim()
  if (needle === '') return undefined
  return workspaces.find((workspace) => workspace.title === needle)
}

/** The row's displayed title: the row's own text (its buttons are icon-only). */
export function rowTitle(row: ElementLike): string {
  return (row.textContent ?? '').trim()
}

const defaultSchedule = (run: () => void): void => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame
  if (typeof raf === 'function') raf(run)
  else globalThis.setTimeout(run, 16)
}

async function defaultCopy(text: string): Promise<void> {
  const scope = globalThis as {
    navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
  }
  const clipboard = scope.navigator?.clipboard
  if (clipboard !== undefined) {
    await clipboard.writeText(text)
    return
  }
  throw new Error('navigator.clipboard is unavailable')
}

/**
 * Install the copy-path bridge. Returns the disposer; removing it deletes
 * every injected button, the observer, listeners and the toast (no state).
 */
export function installWorkspaceCopyPath(options: WorkspaceCopyOptions = {}): () => void {
  const scope = globalThis as unknown as { document?: CopyDocumentLike }
  const doc = options.document ?? scope.document
  const warn = options.warn ?? ((message: string) => console.warn('[dsh-manage-sessions] ' + message))
  const schedule = options.schedule ?? defaultSchedule
  const now = options.now ?? Date.now
  const copiedMs = options.copiedMs ?? 1200
  const toastMs = options.toastMs ?? 2000
  const toastErrorMs = options.toastErrorMs ?? 3500
  if (doc === undefined || doc.body === null || doc.body === undefined) {
    warn('no document body available; workspace copy-path is disabled')
    return () => {}
  }
  const body = doc.body

  let disposed = false
  let scanScheduled = false
  let catalogCache: { at: number; result: CatalogResult } | null = null
  let inflight: Promise<CatalogResult> | null = null
  const flashTimers = new Set<ReturnType<typeof globalThis.setTimeout>>()
  let toastTimer: ReturnType<typeof globalThis.setTimeout> | null = null

  const fetchViaHttp = async (): Promise<CatalogResult> => {
    let lastMessage = 'workspace list request failed'
    for (const url of [WORKSPACES_URL, CATALOG_URL]) {
      try {
        const response = await fetch(url, { method: 'GET' })
        const payload = (await response.json()) as { ok?: boolean; workspaces?: CatalogWorkspace[]; error?: { message?: string } }
        if (payload.ok === true && Array.isArray(payload.workspaces)) return { ok: true, workspaces: payload.workspaces }
        lastMessage = payload.error?.message ?? ('workspace list responded without workspaces (HTTP ' + response.status + ')')
      } catch (error) {
        lastMessage = 'workspace list request failed: ' + String(error)
      }
    }
    return { ok: false, message: lastMessage }
  }

  const loadCatalog = (): Promise<CatalogResult> => {
    const cached = catalogCache
    if (cached !== null && now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.result)
    if (inflight !== null) return inflight
    const fetchCatalog = options.fetchCatalog ?? fetchViaHttp
    inflight = fetchCatalog()
      .then((result) => {
        catalogCache = { at: now(), result }
        inflight = null
        return result
      })
      .catch((error: unknown): CatalogResult => {
        inflight = null
        return { ok: false, message: String(error) }
      })
    return inflight
  }

  const showToast = (message: string, kind: 'ok' | 'error', detail?: string): void => {
    let toast = doc.querySelector('#' + TOAST_ID)
    if (toast === null) {
      toast = doc.createElement('div')
      toast.setAttribute('id', TOAST_ID)
      toast.setAttribute('class', 'dsm-copy-toast')
      toast.setAttribute('role', 'status')
      toast.setAttribute('aria-live', 'polite')
      body.appendChild(toast)
    }
    toast.setAttribute('class', kind === 'error' ? 'dsm-copy-toast dsm-copy-toast--error' : 'dsm-copy-toast')
    toast.setAttribute('title', detail ?? message)
    toast.textContent = detail === undefined ? message : message + ' ' + detail
    if (toastTimer !== null) globalThis.clearTimeout(toastTimer)
    toastTimer = globalThis.setTimeout(() => {
      toast?.remove()
      toastTimer = null
    }, kind === 'error' ? toastErrorMs : toastMs)
  }

  const copyForRow = async (button: ElementLike, row: ElementLike): Promise<void> => {
    const title = rowTitle(row)
    const catalog = await loadCatalog()
    if (!catalog.ok) {
      warn('workspace path copy failed for "' + title + '": ' + catalog.message)
      showToast('复制路径失败', 'error', catalog.message)
      return
    }
    const workspace = matchWorkspace(title, catalog.workspaces)
    if (workspace === undefined) {
      warn('no workspace in the catalog matches sidebar row "' + title + '"; path not copied')
      showToast('未找到该工作区的路径', 'error', '工作区「' + title + '」不在目录中')
      return
    }
    try {
      const copyText = options.copyText ?? defaultCopy
      await copyText(workspace.path)
    } catch (error) {
      warn('clipboard write failed for workspace "' + title + '": ' + String(error))
      showToast('复制路径失败', 'error', '剪贴板不可用')
      return
    }
    button.setAttribute('title', workspace.path)
    const cls = (button.getAttribute('class') ?? '') + ' dsm-copied'
    button.setAttribute('class', cls.trim())
    showToast('已复制工作区路径', 'ok', workspace.path)
    const timer = globalThis.setTimeout(() => {
      if (button.isConnected === false) {
        flashTimers.delete(timer)
        return
      }
      const next = (button.getAttribute('class') ?? '').replace(/\bdsm-copied\b/g, '').trim()
      button.setAttribute('class', next)
      flashTimers.delete(timer)
    }, copiedMs)
    flashTimers.add(timer)
  }

  const buildButton = (row: ElementLike): ElementLike | null => {
    const actions = row.querySelector(ACTIONS_SELECTOR)
    if (actions === null) return null
    if (actions.querySelector('[' + COPY_BUTTON_MARKER + ']') !== null) return null
    const natives = Array.from(actions.querySelectorAll('button'))
    if (natives.length !== 2) return null // ungrouped bucket (1) or unknown shape
    const nativeClass = natives[1]!.getAttribute('class') ?? ''
    const button = doc.createElement('button')
    button.setAttribute('type', 'button')
    button.setAttribute(COPY_BUTTON_MARKER, '1')
    button.setAttribute('class', ('dsm-copy-btn ' + nativeClass).trim())
    button.setAttribute('aria-label', '复制工作区路径')
    button.setAttribute('title', '复制工作区绝对路径')
    const wrapper = button as ElementLike & { innerHTML?: string }
    wrapper.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG
    // Trailing append: React owns child order, CSS order:-1 renders us first.
    // The document-capture click handler is the single copy trigger; a
    // button-level listener would double-fire after its stopPropagation.
    actions.appendChild(button)
    return button
  }

  const scan = (): void => {
    if (disposed) return
    const rows = doc.querySelectorAll(ROW_SELECTOR_EXPANDED)
    for (const row of Array.from(rows)) {
      if (row.hasAttribute('aria-selected')) continue
      if (row.querySelector('[' + COPY_BUTTON_MARKER + ']') !== null) continue
      buildButton(row)
    }
  }

  const requestScan = (): void => {
    if (disposed || scanScheduled) return
    scanScheduled = true
    schedule(() => {
      scanScheduled = false
      scan()
    })
  }

  const onClickCapture = (event: unknown): void => {
    const target = (event as { target?: ElementLike | null }).target
    if (target === null || target === undefined || typeof target.closest !== 'function') return
    if (target.closest('[' + COPY_BUTTON_MARKER + ']') === null) return
    // The row's React handler must not fire: capture on the document runs
    // before the delegated root, so stopPropagation here owns the gesture.
    ;(event as { stopPropagation?: () => void }).stopPropagation?.()
    ;(event as { preventDefault?: () => void }).preventDefault?.()
    if (disposed) return
    const button = target.closest('[' + COPY_BUTTON_MARKER + ']')
    const row = button === null ? null : button.closest(ROW_SELECTOR)
    if (button === null || row === null) return
    void copyForRow(button, row)
  }

  /** Hover prefetch: dwell on a workspace row warms the cache for an instant copy. */
  const onPointerOverCapture = (event: unknown): void => {
    if (disposed) return
    const target = (event as { target?: ElementLike | null }).target
    if (target === null || target === undefined || typeof target.closest !== 'function') return
    const row = target.closest(ROW_SELECTOR_EXPANDED)
    if (row === null || row.hasAttribute('aria-selected')) return
    if (row.querySelector('[' + COPY_BUTTON_MARKER + ']') === null) return
    void loadCatalog()
  }

  const stopObserving = options.observe?.(requestScan) ?? observeDocument(doc, requestScan, warn)
  doc.addEventListener('click', onClickCapture, true)
  doc.addEventListener('pointerover', onPointerOverCapture, true)
  scan()

  return () => {
    if (disposed) return
    disposed = true
    stopObserving()
    doc.removeEventListener('click', onClickCapture, true)
    doc.removeEventListener('pointerover', onPointerOverCapture, true)
    for (const button of Array.from(doc.querySelectorAll('[' + COPY_BUTTON_MARKER + ']'))) button.remove()
    doc.querySelector('#' + TOAST_ID)?.remove()
    for (const timer of flashTimers) globalThis.clearTimeout(timer)
    if (toastTimer !== null) globalThis.clearTimeout(toastTimer)
    flashTimers.clear()
  }
}

/** Default MutationObserver hookup; returns its disposer. */
function observeDocument(doc: CopyDocumentLike, requestScan: () => void, warn: (message: string) => void): () => void {
  const scope = globalThis as {
    MutationObserver?: new (callback: () => void) => { observe(target: unknown, init: unknown): void; disconnect(): void }
  }
  const ObserverCtor = scope.MutationObserver
  if (ObserverCtor === undefined) {
    warn('MutationObserver is unavailable; workspace copy buttons appear on load only')
    return () => {}
  }
  const observer = new ObserverCtor(requestScan)
  const root = doc.body ?? doc.querySelector('body')
  observer.observe(root ?? doc, { childList: true, subtree: true })
  return () => observer.disconnect()
}
