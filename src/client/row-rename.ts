/**
 * Double-click-to-rename bridge for the official sidebar session rows.
 *
 * DSH 0.1.5 owns the session rename dialog inside WorkspaceBrowser state and
 * injects `renameSession` only to the `sidebar.workspaces` occupant, so an
 * external plugin cannot open that dialog directly. This module therefore
 * drives the OFFICIAL path — the row's own overflow button and its Rename
 * menu item — so the dialog that opens is byte-for-byte the native one
 * (prefilled title, cancel/confirm, conflict copy, i18n).
 *
 * Scope contract (user-approved):
 *  - the whole session row is a double-click target EXCEPT its buttons;
 *  - every session row qualifies, whichever session is currently open;
 *  - the dialog always belongs to the double-clicked row.
 *
 * A native double-click first delivers two ordinary clicks, so the row is
 * already opened by the time this bridge runs. That is inherent to putting a
 * second meaning on the same gesture and is accepted: the current session has
 * no side effect, another session is switched to and then renamed.
 *
 * Every lookup is structural and locale-tolerant: rows are identified by
 * `[role="treeitem"][aria-selected]` (workspace rows carry `aria-expanded`
 * instead), the overflow button is the row's only button, and the Rename item
 * is matched by the official `t('rename')` copy with a label fallback.
 * Nothing is guessed silently: a dead end warns once, by name, and leaves the
 * page untouched.
 */

/** Minimal structural DOM surface — keeps the module unit-testable without a DOM. */
export interface ElementLike {
  closest(selector: string): ElementLike | null
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  querySelectorAll(selector: string): ArrayLike<ElementLike>
  click(): void
  isConnected?: boolean
}

export interface DocumentLike {
  addEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
  removeEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
  querySelector(selector: string): ElementLike | null
  dispatchEvent(event: unknown): boolean
}

export interface RenameBridgeOptions {
  /** Document to observe; defaults to the live browser document. */
  document?: DocumentLike
  /** Official `t('rename')` copy for the workspace locale, read lazily per activation. */
  renameLabel?: () => string | undefined
  /** Diagnostic sink; defaults to `console.warn` with the plugin prefix. */
  warn?: (message: string) => void
  /** Upper bound for waiting on the native menu to mount. */
  menuTimeoutMs?: number
  /** Schedule helper; defaults to requestAnimationFrame with a timer fallback. */
  schedule?: (run: () => void) => void
}

const NS = 'dsh-manage-sessions'
const ROW_SELECTOR = '[role="treeitem"]'
const MENU_SELECTOR = '[role="menu"]'
const MENU_ITEM_SELECTOR = '[role="menuitem"]'

/**
 * The session row a double-click landed on, or null when the gesture must be
 * ignored: not a row, a workspace row, or any button inside a row (the
 * overflow trigger keeps its native behavior).
 */
export function sessionRowFor(target: ElementLike | null | undefined): ElementLike | null {
  if (target === null || target === undefined || typeof target.closest !== 'function') return null
  const row = target.closest(ROW_SELECTOR)
  if (row === null) return null
  // Session rows carry aria-selected; workspace rows carry aria-expanded only.
  if (!row.hasAttribute('aria-selected')) return null
  if (target.closest('button') !== null) return null
  return row
}

/** The row's overflow ("...") trigger: the row's only button, else the labeled one. */
export function rowMenuButton(row: ElementLike): ElementLike | null {
  const buttons = Array.from(row.querySelectorAll('button'))
  if (buttons.length === 0) return null
  const labeled = buttons.find((button) => {
    const label = button.getAttribute('aria-label')
    return typeof label === 'string' && /操作|actions?/i.test(label)
  })
  if (labeled !== undefined) return labeled
  return buttons.length === 1 ? buttons[0] : null
}

/**
 * The Rename entry inside an open menu. Matches the official localized copy
 * first, then a conservative label pattern, and never falls back to position.
 */
export function pickRenameItem(menu: ElementLike, renameLabel: string | undefined): ElementLike | null {
  const items = Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR))
  if (items.length === 0) return null
  const text = (item: ElementLike): string => (item as { textContent?: string | null }).textContent?.trim() ?? ''
  if (typeof renameLabel === 'string' && renameLabel !== '') {
    const exact = items.find((item) => text(item) === renameLabel.trim())
    if (exact !== undefined) return exact
  }
  const patterned = items.find((item) => /^(重命名|rename)/i.test(text(item)))
  return patterned ?? null
}

/** Escape key dispatch so a stale menu closes before the bridge opens its own. */
function closeOpenMenu(doc: DocumentLike): void {
  const scope = globalThis as {
    KeyboardEvent?: new (type: string, init?: unknown) => unknown
    Event?: new (type: string, init?: unknown) => unknown
  }
  const Ctor = scope.KeyboardEvent ?? scope.Event
  if (Ctor === undefined) return
  const event = new Ctor('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  if ((event as { key?: string }).key !== 'Escape') {
    try {
      Object.defineProperty(event, 'key', { value: 'Escape' })
    } catch {
      // A read-only key is fine: the owner only needs the keydown signal.
    }
  }
  doc.dispatchEvent(event)
}

const defaultSchedule = (run: () => void): void => {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame
  if (typeof raf === 'function') raf(run)
  else globalThis.setTimeout(run, 16)
}

/**
 * Install the double-click bridge. Returns the disposer; removing it restores
 * the untouched native behavior (no listeners, no state).
 */
export function installSessionRowRename(options: RenameBridgeOptions = {}): () => void {
  const doc = options.document ?? (globalThis as unknown as { document: DocumentLike }).document
  const warn = options.warn ?? ((message: string) => console.warn(`[${NS}] ${message}`))
  const schedule = options.schedule ?? defaultSchedule
  const menuTimeoutMs = options.menuTimeoutMs ?? 400
  if (doc === undefined) {
    warn('no document available; double-click rename is disabled')
    return () => {}
  }

  let disposed = false

  const waitForMenu = (deadline: number): Promise<ElementLike | null> =>
    new Promise((resolve) => {
      const attempt = (): void => {
        if (disposed) {
          resolve(null)
          return
        }
        const menu = doc.querySelector(MENU_SELECTOR)
        if (menu !== null) {
          resolve(menu)
          return
        }
        if (Date.now() >= deadline) {
          resolve(null)
          return
        }
        schedule(attempt)
      }
      schedule(attempt)
    })

  const activate = async (row: ElementLike): Promise<void> => {
    const title = (row as { textContent?: string | null }).textContent?.trim().slice(0, 40) ?? ''
    if (doc.querySelector(MENU_SELECTOR) !== null) {
      closeOpenMenu(doc)
      await new Promise<void>((resolve) => schedule(resolve))
      if (disposed) return
      if (doc.querySelector(MENU_SELECTOR) !== null) {
        warn(`another menu stayed open; double-click rename skipped for session row "${title}"`)
        return
      }
    }
    const button = rowMenuButton(row)
    if (button === null) {
      warn(`session row "${title}" has no overflow button; double-click rename skipped`)
      return
    }
    button.click()
    const menu = await waitForMenu(Date.now() + menuTimeoutMs)
    if (menu === null) {
      warn(`the rename menu did not open for session row "${title}"; double-click rename skipped`)
      return
    }
    const item = pickRenameItem(menu, options.renameLabel?.())
    if (item === null) {
      warn(`the rename entry was not found in the menu for session row "${title}"; double-click rename skipped`)
      return
    }
    item.click()
  }

  const onDoubleClick = (event: unknown): void => {
    const target = (event as { target?: ElementLike | null }).target
    const row = sessionRowFor(target)
    if (row === null) return
    void activate(row)
  }

  doc.addEventListener('dblclick', onDoubleClick, true)
  return () => {
    if (disposed) return
    disposed = true
    doc.removeEventListener('dblclick', onDoubleClick, true)
  }
}
