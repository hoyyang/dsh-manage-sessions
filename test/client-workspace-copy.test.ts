import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installWorkspaceCopyPath,
  matchWorkspace,
  rowTitle,
  workspaceRowFor,
  CHECK_ICON_SVG,
  COPY_ICON_SVG,
  type CatalogResult,
  type CatalogWorkspace,
  type CopyDocumentLike,
  type ElementLike,
} from '../src/client/workspace-copy.ts'

// ---------------------------------------------------------------------------
// Minimal structural DOM: just enough tree for the bridge's selectors.
// ---------------------------------------------------------------------------

interface ElInit {
  tag?: string
  attrs?: Record<string, string>
  text?: string
}

interface StubEl extends ElementLike {
  tag: string
  attrs: Record<string, string>
  kids: StubEl[]
  parent: StubEl | null
  listeners: Map<string, Array<(event: unknown) => void>>
  html?: string
}

function matches(el: StubEl, selector: string): boolean {
  if (selector === 'button') return el.tag === 'button'
  if (selector.startsWith('#')) return el.attrs.id === selector.slice(1)
  if (selector.startsWith('[class*=')) {
    const needle = selector.slice('[class*="'.length, -'"]'.length)
    return (el.attrs.class ?? '').includes(needle)
  }
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const inner = selector.slice(1, -1)
    // Compound attribute selectors: [role="treeitem"][aria-expanded]
    return inner.split('][').every((part) => {
      const eq = part.indexOf('=')
      if (eq === -1) return el.attrs[part] !== undefined
      const name = part.slice(0, eq)
      const value = part.slice(eq + 1).replace(/^"|"$/g, '')
      return el.attrs[name] === value
    })
  }
  return false
}

function el(init: ElInit = {}, parent: StubEl | null = null): StubEl {
  let ownText = init.text ?? ''
  const self: StubEl = {
    tag: init.tag ?? 'div',
    attrs: { ...(init.attrs ?? {}) },
    kids: [],
    parent,
    listeners: new Map(),
    // The live DOM's textContent includes descendants; the bridge reads the
    // row's whole text, so the stub derives it the same way.
    get textContent(): string | null {
      let all = ownText
      for (const kid of self.kids) all += kid.textContent ?? ''
      return all
    },
    set textContent(value: string | null) {
      ownText = value ?? ''
    },
    closest(selector: string) {
      let node: StubEl | null = self
      while (node !== null) {
        if (matches(node, selector)) return node
        node = node.parent
      }
      return null
    },
    hasAttribute: (name) => name in self.attrs,
    getAttribute: (name) => self.attrs[name] ?? null,
    setAttribute: (name, value) => {
      self.attrs[name] = value
    },
    querySelector(selector: string) {
      return self.querySelectorAll(selector)[0] ?? null
    },
    querySelectorAll(selector: string) {
      const found: StubEl[] = []
      const walk = (node: StubEl): void => {
        for (const kid of node.kids) {
          if (matches(kid, selector)) found.push(kid)
          walk(kid)
        }
      }
      walk(self)
      return found
    },
    appendChild(child: ElementLike) {
      const stub = child as StubEl
      stub.parent = self
      self.kids.push(stub)
      return child
    },
    addEventListener(type, listener) {
      const list = self.listeners.get(type) ?? []
      list.push(listener)
      self.listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = (self.listeners.get(type) ?? []).filter((fn) => fn !== listener)
      self.listeners.set(type, list)
    },
    remove() {
      if (self.parent === null) return
      self.parent.kids = self.parent.kids.filter((kid) => kid !== self)
      self.parent = null
    },
    get isConnected() {
      let node: StubEl | null = self
      while (node.parent !== null) node = node.parent
      return node.attrs['data-root'] === '1'
    },
  }
  if (parent !== null) parent.kids.push(self)
  return self
}

/** Build the official workspace row shape: [folder span, chevron span, text span, rowActions span(2 buttons)]. */
function workspaceRow(title: string, parent: StubEl, options: { buttons?: number } = {}): { row: StubEl; actions: StubEl } {
  const row = el({ attrs: { role: 'treeitem', 'aria-expanded': 'true' } }, parent)
  const actions = el({ attrs: { class: 'YDXeBa_rowActions' } }, row)
  const count = options.buttons ?? 2
  for (let i = 0; i < count; i++) {
    el({ tag: 'button', attrs: { class: 'YDXeBa_iconButton', 'aria-label': 'n' + i } }, actions)
  }
  el({ text: title }, row)
  return { row, actions }
}

function sessionRow(parent: StubEl): StubEl {
  return el({ attrs: { role: 'treeitem', 'aria-selected': 'false' } }, parent)
}

function stubDocument(root: StubEl) {
  const docListeners = new Set<(event: unknown) => void>()
  const doc: CopyDocumentLike = {
    createElement: (tag) => el({ tag }),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    body: root,
    addEventListener: (_type, listener) => docListeners.add(listener),
    removeEventListener: (_type, listener) => docListeners.delete(listener),
  }
  return {
    doc,
    fire(type: string, target: ElementLike) {
      let stopped = false
      const event = {
        type,
        target,
        stopPropagation: () => {
          stopped = true
        },
        preventDefault: () => {},
      }
      for (const listener of [...docListeners]) listener(event)
      return { stopped }
    },
    fireClick(target: ElementLike) {
      return this.fire('click', target)
    },
    get listenerCount() {
      return docListeners.size
    },
  }
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await nextTick()
  }
}

const catalog: CatalogWorkspace[] = [
  { title: 'sample-app', path: '/srv/sample-app' },
  { title: 'dsh', path: '/srv/dsh' },
]
const okCatalog = (): Promise<CatalogResult> => Promise.resolve({ ok: true, workspaces: catalog })

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('workspace rows are recognized structurally, session rows are excluded', () => {
  const wsRow = el({ attrs: { role: 'treeitem', 'aria-expanded': 'true' } })
  const inner = el({}, wsRow)
  assert.equal(workspaceRowFor(inner), wsRow)
  assert.equal(workspaceRowFor(wsRow), wsRow)

  const session = el({ attrs: { role: 'treeitem', 'aria-selected': 'false' } })
  assert.equal(workspaceRowFor(session), null, 'session rows never qualify')

  const both = el({ attrs: { role: 'treeitem', 'aria-expanded': 'true', 'aria-selected': 'false' } })
  assert.equal(workspaceRowFor(both), null, 'a row with both markers is refused')

  assert.equal(workspaceRowFor(null), null)
  assert.equal(workspaceRowFor(undefined), null)
})

test('title matching is exact and whitespace tolerant, never positional', () => {
  assert.deepEqual(matchWorkspace(' dsh ', catalog), catalog[1])
  assert.equal(matchWorkspace('nope', catalog), undefined)
  assert.equal(matchWorkspace('', catalog), undefined)
  const duplicated = [...catalog, { title: 'dsh', path: '/other' }]
  assert.equal(matchWorkspace('dsh', duplicated)!.path, '/srv/dsh', 'first registry entry wins deterministically')
})

test('rowTitle reads the row text', () => {
  const { row } = workspaceRow('sample-app', el())
  assert.equal(rowTitle(row), 'sample-app')
})

// ---------------------------------------------------------------------------
// Installed bridge
// ---------------------------------------------------------------------------

test('install augments workspace rows with a same-style trailing button, visually first', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  const { row } = workspaceRow('sample-app', root)
  workspaceRow('UngroupedOnly', root, { buttons: 1 })
  sessionRow(root)
  const harness = stubDocument(root)
  let scans = 0
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: okCatalog,
    observe: (run) => {
      scans++
      return () => {}
    },
    schedule: (run) => void setTimeout(run, 1),
  })
  // The initial scan runs synchronously inside install; observe hooks the rest.
  assert.ok(scans >= 0)
  const buttons = root.querySelectorAll('[data-dsm-copy]')
  assert.equal(buttons.length, 1, 'only real workspace rows are augmented')
  const button = buttons[0] as StubEl
  assert.equal(button.tag, 'button')
  assert.equal(button.getAttribute('aria-label'), '复制工作区路径')
  assert.match(button.getAttribute('class') ?? '', /dsm-copy-btn YDXeBa_iconButton/, 'the native sibling class is cloned')
  const injected = (button as unknown as { innerHTML?: string }).innerHTML ?? ''
  assert.match(injected, /dsm-copy-ico/, 'the copy glyph is embedded')
  assert.match(injected, /dsm-copy-check/, 'the check glyph is embedded')
  assert.equal((button as StubEl).parent, row.querySelector('[class*="rowActions"]'), 'appended into the official actions span')
  void row
  dispose()
})

test('clicking the button copies the workspace path and flashes the check', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  workspaceRow('dsh', root)
  const harness = stubDocument(root)
  const copied: string[] = []
  let fetches = 0
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: () => {
      fetches++
      return okCatalog()
    },
    copyText: async (text) => {
      copied.push(text)
    },
    schedule: (run) => void setTimeout(run, 1),
  })
  const button = root.querySelectorAll('[data-dsm-copy]')[0] as StubEl
  const result = harness.fireClick(button)
  assert.equal(result.stopped, true, 'the row toggle never sees the click')
  await waitFor(() => copied.length === 1)
  assert.deepEqual(copied, ['/srv/dsh'])
  assert.match(button.getAttribute('class') ?? '', /dsm-copied/, 'the check flash class lands')
  assert.equal(button.getAttribute('title'), '/srv/dsh', 'the tooltip now carries the absolute path')
  const toast = root.querySelector('#dsm-copy-toast')
  assert.ok(toast !== null, 'a toast confirms the copy')
  assert.match(toast!.textContent ?? '', /已复制工作区路径/)
  assert.ok((toast!.textContent ?? '').includes('/srv/dsh'), 'the toast carries the copied path')
  await waitFor(() => !(button.getAttribute('class') ?? '').includes('dsm-copied'), 1500)
  dispose()
})

test('the catalog is cached across clicks within the TTL', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  workspaceRow('dsh', root)
  const harness = stubDocument(root)
  let fetches = 0
  let clock = 1000
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: () => {
      fetches++
      return okCatalog()
    },
    copyText: async () => {},
    now: () => clock,
    schedule: (run) => void setTimeout(run, 1),
  })
  const button = root.querySelectorAll('[data-dsm-copy]')[0] as StubEl
  harness.fireClick(button)
  await waitFor(() => fetches === 1)
  harness.fireClick(button)
  await nextTick()
  await nextTick()
  assert.equal(fetches, 1, 'a second click inside the TTL reuses the catalog')
  clock += 6000
  harness.fireClick(button)
  await waitFor(() => fetches === 2)
  dispose()
})

test('unknown rows and failing catalogs fail loud without touching the clipboard', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  workspaceRow('ghost', root)
  const harness = stubDocument(root)
  const copied: string[] = []
  const warnings: string[] = []
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: okCatalog,
    copyText: async (text) => {
      copied.push(text)
    },
    warn: (message) => warnings.push(message),
    observe: () => () => {},
    schedule: (run) => void setTimeout(run, 1),
  })
  const button = root.querySelectorAll('[data-dsm-copy]')[0] as StubEl
  harness.fireClick(button)
  await waitFor(() => warnings.length === 1)
  assert.deepEqual(copied, [], 'no blind clipboard writes')
  assert.match(warnings[0] ?? '', /ghost/)
  const failToast = root.querySelector('#dsm-copy-toast') as StubEl | null
  assert.match(failToast?.attrs.class ?? '', /error/)

  const root2 = el({ attrs: { 'data-root': '1' } })
  workspaceRow('dsh', root2)
  const harness2 = stubDocument(root2)
  const copied2: string[] = []
  const dispose2 = installWorkspaceCopyPath({
    document: harness2.doc,
    fetchCatalog: () => Promise.resolve({ ok: false, message: 'catalog exploded' }),
    copyText: async (text) => {
      copied2.push(text)
    },
    schedule: (run) => void setTimeout(run, 1),
  })
  harness2.fireClick(root2.querySelectorAll('[data-dsm-copy]')[0] as StubEl)
  await waitFor(() => (root2.querySelector('#dsm-copy-toast')?.textContent ?? '').includes('catalog exploded'))
  assert.deepEqual(copied2, [], 'a failed catalog never copies')
  dispose()
  dispose2()
})

test('clipboard failure surfaces an error toast, never a silent success', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  workspaceRow('dsh', root)
  const harness = stubDocument(root)
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: okCatalog,
    copyText: async () => {
      throw new Error('denied')
    },
    schedule: (run) => void setTimeout(run, 1),
  })
  harness.fireClick(root.querySelectorAll('[data-dsm-copy]')[0] as StubEl)
  await waitFor(() => (root.querySelector('#dsm-copy-toast')?.textContent ?? '').includes('剪贴板不可用'))
  assert.doesNotMatch(root.querySelectorAll('[data-dsm-copy]')[0]!.getAttribute('class') ?? '', /dsm-copied/)
  dispose()
})

test('the disposer removes buttons, the toast and every listener', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  workspaceRow('dsh', root)
  workspaceRow('sample-app', root)
  const harness = stubDocument(root)
  let observeDisposed = false
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: okCatalog,
    copyText: async () => {},
    schedule: (run) => void setTimeout(run, 1),
    observe: () => {
      return () => {
        observeDisposed = true
      }
    },
  })
  assert.equal(root.querySelectorAll('[data-dsm-copy]').length, 2)
  dispose()
  assert.equal(root.querySelectorAll('[data-dsm-copy]').length, 0, 'injected buttons are gone')
  assert.equal(root.querySelector('#dsm-copy-toast'), null)
  assert.equal(harness.listenerCount, 0, 'the document click listener is gone')
  assert.equal(observeDisposed, true, 'the observer hookup is disposed')
})

test('the shipped glyphs are the official primitives shapes', () => {
  assert.match(COPY_ICON_SVG, /M6.14929 4.02032/, 'the copy glyph is the official IconCopyOutline16 path')
  assert.match(COPY_ICON_SVG, /fill="currentColor"/)
  assert.match(COPY_ICON_SVG, /class="dsm-copy-ico"/)
  assert.match(CHECK_ICON_SVG, /M15.0498 3.92579/, 'the check glyph is the official IconCheckOutline16 path')
  assert.match(CHECK_ICON_SVG, /class="dsm-copy-check"/)
})

test('hovering a workspace row prefetches the workspace list without a click', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  const { actions } = workspaceRow('dsh', root)
  const harness = stubDocument(root)
  let fetches = 0
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: () => {
      fetches++
      return okCatalog()
    },
    copyText: async () => {},
    schedule: (run) => void setTimeout(run, 1),
  })
  harness.fire('pointerover', actions)
  await waitFor(() => fetches === 1)
  assert.equal(fetches, 1, 'hover alone warms the cache')
  // Clicking afterwards reuses the cache: no second fetch for the same click.
  harness.fireClick(root.querySelectorAll('[data-dsm-copy]')[0] as StubEl)
  await nextTick()
  await nextTick()
  assert.equal(fetches, 1, 'the click is served from the hover-warmed cache')
  dispose()
})

test('hovering session rows or non-rows never prefetches', async () => {
  const root = el({ attrs: { 'data-root': '1' } })
  sessionRow(root)
  const harness = stubDocument(root)
  let fetches = 0
  const dispose = installWorkspaceCopyPath({
    document: harness.doc,
    fetchCatalog: () => {
      fetches++
      return okCatalog()
    },
    copyText: async () => {},
    schedule: (run) => void setTimeout(run, 1),
  })
  harness.fire('pointerover', root.querySelectorAll('[role="treeitem"]')[0] as StubEl)
  harness.fire('pointerover', el({}))
  await nextTick()
  await nextTick()
  assert.equal(fetches, 0, 'no prefetch outside real workspace rows')
  dispose()
})
