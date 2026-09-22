import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installSessionRowRename,
  pickRenameItem,
  rowMenuButton,
  sessionRowFor,
  type DocumentLike,
  type ElementLike,
} from '../src/client/row-rename.ts'

interface StubInit {
  text?: string
  attrs?: Record<string, string>
  row?: ElementLike | null
  buttons?: ElementLike[]
  items?: ElementLike[]
  clicks?: string[]
  id?: string
  /** Marks this stub as a <button> so closest('button') resolves to itself. */
  isButton?: boolean
  /** Marks this stub as a row element so closest('[role="treeitem"]') resolves to itself. */
  isRow?: boolean
}

function stub(init: StubInit = {}): ElementLike {
  const self: ElementLike & { textContent?: string } = {
    closest(selector: string) {
      if (selector === 'button') return init.isButton === true ? self : null
      if (selector === '[role="treeitem"]') return init.row ?? (init.isRow === true ? self : null)
      return null
    },
    hasAttribute: (name: string) => name in (init.attrs ?? {}),
    getAttribute: (name: string) => (init.attrs ?? {})[name] ?? null,
    querySelectorAll(selector: string) {
      if (selector === 'button') return init.buttons ?? []
      if (selector === '[role="menuitem"]') return init.items ?? []
      return []
    },
    click() {
      init.clicks?.push(init.id ?? 'click')
    },
    get isConnected() {
      return true
    },
    textContent: init.text ?? '',
  }
  return self
}

/** Stand-in document: one optional open menu, recorded listeners and escapes. */
function stubDocument(menuRef: { current: ElementLike | null }) {
  const listeners = new Set<(event: unknown) => void>()
  const escapes: number[] = []
  const doc: DocumentLike = {
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
    querySelector: (selector) => (selector === '[role="menu"]' ? menuRef.current : null),
    dispatchEvent() {
      escapes.push(1)
      return true
    },
  }
  return {
    doc,
    escapes,
    fire(target: ElementLike) {
      for (const listener of [...listeners]) listener({ target })
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
const schedule = (run: () => void) => {
  setTimeout(run, 1)
}

async function waitFor(predicate: () => boolean, timeoutMs = 400): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await nextTick()
  }
}

test('session rows are recognized structurally and buttons stay native', () => {
  const row = stub({ attrs: { 'aria-selected': 'false' }, isRow: true })
  assert.equal(sessionRowFor(stub({ row })), row, 'a session row qualifies from any inner element')
  assert.equal(sessionRowFor(row), row, 'the row itself qualifies')

  const workspaceRow = stub({ attrs: { 'aria-expanded': 'true' }, isRow: true })
  assert.equal(sessionRowFor(stub({ row: workspaceRow })), null, 'workspace rows are excluded')

  assert.equal(sessionRowFor(stub({ row: null })), null, 'non-row targets are ignored')
  assert.equal(sessionRowFor(null), null, 'missing targets are ignored')

  const button = stub({ id: 'overflow', isButton: true, row })
  assert.equal(sessionRowFor(button), null, 'the overflow button keeps its native behavior')
})

test('the overflow trigger is the row button, preferring the labeled one', () => {
  const only = stub({ id: 'only' })
  assert.equal(rowMenuButton(stub({ buttons: [only] })), only)
  assert.equal(rowMenuButton(stub({ buttons: [] })), null)

  const labeled = stub({ attrs: { 'aria-label': '会话“x”的操作' } })
  const other = stub({ attrs: { 'aria-label': '别的按钮' } })
  assert.equal(rowMenuButton(stub({ buttons: [other, labeled] })), labeled, 'an explicit actions label wins')

  const english = stub({ attrs: { 'aria-label': 'Session "x" actions' } })
  assert.equal(rowMenuButton(stub({ buttons: [other, english] })), english, 'the label match is locale tolerant')

  assert.equal(rowMenuButton(stub({ buttons: [other, other] })), null, 'ambiguity is refused, never guessed')
})

test('the rename entry is matched by official copy, then by label pattern', () => {
  const rename = stub({ text: '重命名' })
  const fork = stub({ text: '分叉会话' })
  const archive = stub({ text: '归档会话' })
  const menu = stub({ items: [rename, fork, archive] })

  assert.equal(pickRenameItem(menu, '重命名'), rename)
  assert.equal(pickRenameItem(menu, undefined), rename, 'the pattern fallback still finds rename')
  assert.equal(pickRenameItem(stub({ items: [fork, archive] }), '重命名'), null, 'no positional fallback')
  assert.equal(pickRenameItem(stub({ items: [] }), '重命名'), null)

  const englishRename = stub({ text: 'Rename' })
  assert.equal(pickRenameItem(stub({ items: [englishRename] }), 'Rename'), englishRename)
  assert.equal(pickRenameItem(stub({ items: [englishRename] }), undefined), englishRename)
})

test('double-clicking a session row drives the official menu into the rename dialog', async () => {
  const clicks: string[] = []
  const rename = stub({ text: '重命名', clicks, id: 'rename-item' })
  const fork = stub({ text: '分叉会话', clicks, id: 'fork-item' })
  const menu = stub({ items: [rename, fork] })
  const menuRef: { current: ElementLike | null } = { current: null }
  const harness = stubDocument(menuRef)
  const button = stub({ attrs: { 'aria-label': '会话“x”的操作' }, clicks, id: 'overflow' })
  const row = stub({ attrs: { 'aria-selected': 'false' }, buttons: [button], clicks, id: 'row', text: 'x' })
  const title = stub({ row, clicks })
  button.click = () => {
    clicks.push('overflow')
    menuRef.current = menu
  }
  const warnings: string[] = []
  const dispose = installSessionRowRename({
    document: harness.doc,
    renameLabel: () => '重命名',
    warn: (message) => warnings.push(message),
    schedule,
    menuTimeoutMs: 50,
  })

  harness.fire(title)
  await waitFor(() => clicks.includes('rename-item'))
  assert.deepEqual(clicks, ['overflow', 'rename-item'])
  assert.deepEqual(warnings, [])
  dispose()
  assert.equal(harness.listenerCount, 0, 'the disposer removes the listener')
})

test('non-row targets, workspace rows and overflow clicks never activate rename', async () => {
  const clicks: string[] = []
  const menuRef: { current: ElementLike | null } = { current: null }
  const harness = stubDocument(menuRef)
  const button = stub({ attrs: { 'aria-label': '会话“x”的操作' }, clicks, id: 'overflow' })
  const row = stub({ attrs: { 'aria-selected': 'false' }, buttons: [button], clicks, id: 'row' })
  const workspaceRow = stub({ attrs: { 'aria-expanded': 'true' } })
  button.click = () => {
    clicks.push('overflow')
  }
  installSessionRowRename({ document: harness.doc, renameLabel: () => '重命名', warn: () => {}, schedule, menuTimeoutMs: 20 })

  harness.fire(stub({ row: null }))
  harness.fire(stub({ row: workspaceRow }))
  harness.fire(stub({ row, isButton: true })) // click landed on the "..." trigger
  await nextTick()
  assert.deepEqual(clicks, [], 'no path reached the overflow trigger')
})

test('a missing menu or a missing rename entry warns by name and clicks nothing else', async () => {
  const clicks: string[] = []
  const menuRef: { current: ElementLike | null } = { current: null }
  const harness = stubDocument(menuRef)
  const button = stub({ attrs: { 'aria-label': '会话“x”的操作' }, clicks, id: 'overflow' })
  const row = stub({ attrs: { 'aria-selected': 'false' }, buttons: [button], clicks, id: 'row', text: '目标会话' })
  const title = stub({ row, clicks })
  button.click = () => {
    clicks.push('overflow')
  }
  const warnings: string[] = []
  installSessionRowRename({
    document: harness.doc,
    renameLabel: () => '重命名',
    warn: (message) => warnings.push(message),
    schedule,
    menuTimeoutMs: 20,
  })

  harness.fire(title)
  await waitFor(() => warnings.length === 1)
  assert.equal(clicks.filter((entry) => entry !== 'overflow').length, 0, 'nothing beyond the trigger was clicked')
  assert.match(warnings[0] ?? '', /did not open/)
  assert.match(warnings[0] ?? '', /目标会话/, 'the warning names the target row')

  // A menu without the rename entry must also refuse rather than guess.
  button.click = () => {
    clicks.push('overflow')
    menuRef.current = stub({ items: [stub({ text: '分叉会话', clicks, id: 'fork-item' })] })
  }
  warnings.length = 0
  clicks.length = 0
  harness.fire(title)
  await waitFor(() => warnings.length === 1)
  assert.deepEqual(clicks, ['overflow'])
  assert.match(warnings[0] ?? '', /rename entry was not found/)
})

test('a stale open menu is closed with Escape before the bridge opens its own', async () => {
  const clicks: string[] = []
  const rename = stub({ text: '重命名', clicks, id: 'rename-item' })
  const stale: ElementLike = stub({ items: [stub({ text: '分叉会话' })] })
  const menuRef: { current: ElementLike | null } = { current: stale }
  const harness = stubDocument(menuRef)
  const originalDispatch = harness.doc.dispatchEvent
  harness.doc.dispatchEvent = (event: unknown) => {
    menuRef.current = null // the owner honors Escape
    return originalDispatch(event)
  }
  const button = stub({ attrs: { 'aria-label': '会话“x”的操作' }, clicks, id: 'overflow' })
  const row = stub({ attrs: { 'aria-selected': 'false' }, buttons: [button], clicks, id: 'row' })
  const title = stub({ row, clicks })
  button.click = () => {
    clicks.push('overflow')
    menuRef.current = stub({ items: [rename] })
  }
  installSessionRowRename({ document: harness.doc, renameLabel: () => '重命名', warn: () => {}, schedule, menuTimeoutMs: 50 })

  harness.fire(title)
  await waitFor(() => clicks.includes('rename-item'))
  assert.equal(harness.escapes.length, 1, 'the stale menu was dismissed first')
  assert.deepEqual(clicks, ['overflow', 'rename-item'])
})

test('an unrelated menu that ignores Escape is reported instead of guessed at', async () => {
  const clicks: string[] = []
  const menuRef: { current: ElementLike | null } = { current: stub({ items: [stub({ text: '重命名', clicks, id: 'foreign-rename' })] }) }
  const harness = stubDocument(menuRef)
  const button = stub({ attrs: { 'aria-label': '会话“x”的操作' }, clicks, id: 'overflow' })
  const row = stub({ attrs: { 'aria-selected': 'false' }, buttons: [button], clicks, id: 'row', text: '目标会话' })
  const warnings: string[] = []
  installSessionRowRename({
    document: harness.doc,
    renameLabel: () => '重命名',
    warn: (message) => warnings.push(message),
    schedule,
    menuTimeoutMs: 20,
  })

  harness.fire(stub({ row, clicks }))
  await waitFor(() => warnings.length === 1)
  assert.deepEqual(clicks, [], 'no trigger and no foreign menu item was clicked')
  assert.match(warnings[0] ?? '', /another menu stayed open/)
})
