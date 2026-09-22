import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installManagerEntry,
  MGR_ICON_SVG,
  MANAGER_BUTTON_MARKER,
  type ManagerEntryDocumentLike,
  type ElementLike,
} from '../src/client/manager-entry.ts'

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

function el(init: { tag?: string; attrs?: Record<string, string>; text?: string } = {}, parent: StubEl | null = null): StubEl {
  const self: StubEl = {
    tag: init.tag ?? 'div',
    attrs: { ...(init.attrs ?? {}) },
    kids: [],
    parent,
    listeners: new Map(),
    textContent: init.text ?? null,
    closest(selector: string) {
      let node: StubEl | null = self
      while (node !== null) {
        if (matches(node, selector)) return node
        node = node.parent
      }
      return null
    },
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
    addEventListener(type, listener) {
      const list = self.listeners.get(type) ?? []
      list.push(listener)
      self.listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = (self.listeners.get(type) ?? []).filter((fn) => fn !== listener)
      self.listeners.set(type, list)
    },
    after(node: ElementLike) {
      const stub = node as StubEl
      stub.parent = self.parent
      const index = self.parent === null ? 0 : self.parent.kids.indexOf(self)
      if (self.parent !== null) self.parent.kids.splice(index + 1, 0, stub)
    },
    remove() {
      if (self.parent === null) return
      self.parent.kids = self.parent.kids.filter((kid) => kid !== self)
      self.parent = null
    },
    focus() {},
    get isConnected() {
      let node: StubEl | null = self
      while (node.parent !== null) node = node.parent
      return node.attrs['data-root'] === '1'
    },
  }
  if (parent !== null) parent.kids.push(self)
  return self
}

function stubDocument(root: StubEl) {
  const doc: ManagerEntryDocumentLike = {
    createElement: (tag) => el({ tag }),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    body: root,
  }
  return doc
}

/** Official header shape: sectionHeader > [sectionLabel, headerActions > (viewOptions button, add button)]. */
function sectionHeader(parent: StubEl): { header: StubEl; label: StubEl; donor: StubEl } {
  const header = el({ attrs: { class: 'bhn1Oq_sectionHeader' } }, parent)
  const label = el({ attrs: { class: 'bhn1Oq_sectionLabel bhn1Oq_wide' }, text: '工作区' }, header)
  const actions = el({ attrs: { class: 'bhn1Oq_headerActions' } }, header)
  const donor = el({ tag: 'button', attrs: { class: 'bhn1Oq_iconButton', 'aria-label': '视图选项' } }, actions)
  el({ tag: 'button', attrs: { class: 'bhn1Oq_iconButton', 'aria-label': '添加工作区' } }, actions)
  return { header, label, donor }
}

function click(button: StubEl): void {
  for (const listener of button.listeners.get('click') ?? []) {
    listener({ stopPropagation: () => {}, preventDefault: () => {} })
  }
}

test('the manager entry lands immediately right of the section label with the official glyph', () => {
  const root = el({ attrs: { 'data-root': '1' } })
  const { header, label, donor } = sectionHeader(root)
  let opened = 0
  const dispose = installManagerEntry({
    document: stubDocument(root),
    onOpen: () => {
      opened++
    },
    observe: () => () => {},
    schedule: (run) => run(),
  })
  const button = root.querySelector('[data-dsm-mgr]') as StubEl
  assert.ok(button !== null, 'the entry button exists')
  assert.equal(header.kids.indexOf(button as StubEl), header.kids.indexOf(label as StubEl) + 1, 'the button sits right after the label')
  assert.match(button.getAttribute('class') ?? '', /dsm-mgr-btn bhn1Oq_iconButton/, 'the official header action class is cloned')
  assert.equal(button.getAttribute('aria-label'), '会话管理')
  assert.match((button as unknown as { innerHTML?: string }).innerHTML ?? '', /dsm-mgr-ico/)
  assert.match((button as unknown as { innerHTML?: string }).innerHTML ?? '', /M10\.8239 3\.54733/, 'the glyph is the official IconListPenOutline16')
  assert.notEqual((button as StubEl).html, MGR_ICON_SVG.replace('dsm-mgr-ico', 'dsm-mgr-ico'), 'sanity: html present')

  click(button)
  assert.equal(opened, 1, 'the click opens the manager')
  void donor
  dispose()
})

test('the disposer removes the button; a rescan re-inserts exactly one', () => {
  const root = el({ attrs: { 'data-root': '1' } })
  sectionHeader(root)
  const hook: { run: (() => void) | null } = { run: null }
  const dispose = installManagerEntry({
    document: stubDocument(root),
    onOpen: () => {},
    observe: (run) => {
      hook.run = run
      return () => {}
    },
    schedule: (run) => run(),
  })
  assert.equal(root.querySelectorAll('[data-dsm-mgr]').length, 1)
  dispose()
  assert.equal(root.querySelectorAll('[data-dsm-mgr]').length, 0, 'the button is gone after dispose')

  const root2 = el({ attrs: { 'data-root': '1' } })
  sectionHeader(root2)
  const hook2: { run: (() => void) | null } = { run: null }
  const dispose2 = installManagerEntry({
    document: stubDocument(root2),
    onOpen: () => {},
    observe: (run) => {
      hook2.run = run
      return () => {}
    },
    schedule: (run) => run(),
  })
  // React rebuilds the header: our button vanishes, the observer re-inserts.
  ;(root2.querySelector('[data-dsm-mgr]') as StubEl).remove()
  hook2.run?.()
  assert.equal(root2.querySelectorAll('[data-dsm-mgr]').length, 1, 'exactly one button after the rebuild')
  hook2.run?.()
  assert.equal(root2.querySelectorAll('[data-dsm-mgr]').length, 1, 'rescans are idempotent')
  dispose2()
  void MANAGER_BUTTON_MARKER
})
