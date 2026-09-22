import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const sourcePath = resolve(process.cwd(), 'src/client/ManagerWindow.tsx')

test('mobile detail isolates the covered list and returns focus to its trigger', async () => {
  const source = await readFile(sourcePath, 'utf8')

  assert.match(source, /useMediaQuery\('\(max-width: 720px\)'\)/)
  assert.match(source, /className="dsm-list" aria-hidden=\{mobileDetail && current !== null \? true : undefined\}.*inert: ''/)
  assert.match(source, /className="dsm-detail" data-open=\{current !== null\} aria-hidden=\{mobileDetail && current === null \? true : undefined\}.*inert: ''/)
  assert.match(source, /querySelector<HTMLElement>\('\.dsm-detail-close'\)\?\.focus\(\)/)
  assert.match(source, /const activeRoot = \(\) => focusScopeRef\.current === undefined \? root\.current : root\.current\?\.querySelector<HTMLElement>\(focusScopeRef\.current\) \?\? null/)
  assert.match(source, /focusScope=\{mobileDetail && current !== null \? '\.dsm-detail' : undefined\}/)
  assert.match(source, /detailTriggerRef\.current = trigger\n\s+if \(mobileDetail\) trigger\.blur\(\)\n\s+setCurrentId\(id\)/)
  assert.match(source, /restoreDetailFocus\(\)\n\s+setCurrentId\(null\)/)
  assert.match(source, /const restoreDetailFocus = useCallback\(\(\) => \{\n\s+const trigger = detailTriggerRef\.current\n\s+detailTriggerRef\.current = null\n\s+if \(!mobileDetail \|\| trigger === null\) return/)
  assert.match(source, /trigger\?\.isConnected === true\) trigger\.focus\(\)/)
  assert.match(source, /#dsm-tab-\$\{tab\}/)
  assert.match(source, /changeTab = \(next: ManagerTab\) => \{ detailTriggerRef\.current = null; setTab\(next\); setCurrentId\(null\) \}/)
})
