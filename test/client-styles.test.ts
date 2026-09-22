import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSS, STYLE_OWNER } from '../src/client/styles.ts'

test('explicit React style owner is immune to module claim and unrelated HMR removal', () => {
  const moduleId = '@dsh-external/dsh-manage-sessions'
  const styles = [
    { plugin: null as string | null },
    { plugin: STYLE_OWNER as string | null },
  ]
  for (const style of styles) if (style.plugin === null) style.plugin = moduleId
  const afterClaim = styles.filter((style) => style.plugin !== moduleId)

  assert.notEqual(STYLE_OWNER, moduleId)
  assert.deepEqual(afterClaim, [{ plugin: STYLE_OWNER }])
})

test('manager stylesheet retains the responsive and themed owner rules', () => {
  assert.match(CSS, /\.dsm-window,\.dsm-confirm/)
  assert.match(CSS, /var\(--dsw-alias-bg-base/)
  assert.match(CSS, /@media\(max-width:720px\)/)
  assert.match(CSS, /\.dsm-group-check-cell\{[^}]*width:44px;height:44px/)
  assert.match(CSS, /\.dsm-group-toggle,\.dsm-tab,\.dsm-icon-btn,\.dsm-detail button\{min-width:44px;min-height:44px/)
})
