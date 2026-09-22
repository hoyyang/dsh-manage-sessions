import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  archiveCapabilityMessage,
  blockerRows,
  canonicalGroups,
  canonicalTitle,
  contextPercent,
  displayTitle,
  formatInstant,
  sessionVisible,
  statusLabel,
  type CanonicalSessionList,
  type CanonicalSessionSummary,
  type CanonicalWorkspace,
} from '../src/client/model.ts'

const capabilities = {
  catalog: true, disposalStatus: true, disposeBatch: true, archive: true, archiveBatch: false,
  unarchiveAvailable: true, delete: true, stateReady: true, projectionsLive: true, projectionsCold: true, forceStop: true, forceStopResume: true,
}

function summary(id: string, fields: Partial<CanonicalSessionSummary> = {}): CanonicalSessionSummary {
  return { id, displayTitle: `Title ${id}`, running: false, blank: false, updatedAt: 2, ...fields }
}

function fixtures() {
  const byId = {
    a: summary('a', { displayTitle: '用户最新重命名' }),
    b: summary('b'),
    c: summary('c', { updatedAt: 9 }),
    blank: summary('blank', { displayTitle: 'draft', blank: true }),
    child: summary('child', { origin: 'subagent' }),
  }
  const list: CanonicalSessionList = { ids: ['a', 'b', 'c', 'blank', 'child'], byId, current: 'blank', phase: 'ready' }
  const workspaces: CanonicalWorkspace[] = [{ workspaceId: 'w', path: '/repo', title: 'Repo', createdAt: 'now', updatedAt: 'now', sessionIds: ['a', 'b', 'blank'] }]
  return { list, workspaces }
}

test('canonical groups exactly mirror homepage visibility, workspace order, and latest runtime title', () => {
  const { list, workspaces } = fixtures()
  const active = canonicalGroups(list, workspaces, ['b'], 'active', '新会话', '未分组')
  assert.deepEqual(active.map((group) => [group.title, group.sessions.map((item) => item.id)]), [
    ['Repo', ['a', 'blank']], ['未分组', ['c']],
  ])
  assert.equal(active[0].sessions[0].title, '用户最新重命名')
  assert.equal(active[0].sessions[1].title, '新会话')
  assert.equal(displayTitle(active[1].sessions[0]), 'Title c')
  assert.equal(displayTitle({ id: 'spaced', title: ' project ' }), ' project ')
  assert.equal(displayTitle({ id: 'spaces', title: '   ' }), '   ')
  assert.equal(displayTitle({ id: 'missing', title: null }), 'missing')
  assert.equal(active.flatMap((group) => group.sessions).some((item) => item.id === 'child'), false)

  const archived = canonicalGroups(list, workspaces, ['b'], 'archived', '新会话', '未分组')
  assert.deepEqual(archived.map((group) => [group.title, group.sessions.map((item) => item.id)]), [['Repo', ['b']]])
  assert.equal(archived[0].sessions[0].title, 'Title b') // canonical feed beats stale catalog
})

test('official visibility contract keeps only current blank and excludes subagents and archives', () => {
  const archived = new Set(['archived'])
  assert.equal(sessionVisible(summary('ordinary'), undefined, archived), true)
  assert.equal(sessionVisible(summary('blank', { blank: true }), undefined, archived), false)
  assert.equal(sessionVisible(summary('blank', { blank: true }), 'blank', archived), true)
  assert.equal(sessionVisible(summary('archived'), undefined, archived), false)
  assert.equal(sessionVisible(summary('child', { origin: 'subagent' }), undefined, archived), false)
  assert.equal(canonicalTitle(summary('blank', { blank: true, displayTitle: 'ignored' })), 'New Session')
  assert.equal(canonicalTitle(summary('blank', { blank: true, displayTitle: 'ignored' }), '新会话'), '新会话')
})

test('client model uses live projections and labels unavailable values explicitly', () => {
  const { list, workspaces } = fixtures()
  list.byId.a.projectionValues = {
    contextPressure: { projectedTokens: 140, contextWindow: 100 },
    sessionStats: { turns: 1, steps: 2, llmMs: 3, toolMs: 4, ttftMs: 5, ttftSteps: 1, decodeMs: 6, decodeTokens: 7 },
  }
  const active = canonicalGroups(list, workspaces, ['b'], 'active')
  const session = active[0].sessions[0]
  assert.equal(contextPercent(session), 140)
  assert.equal(session.agentWorkMs, 7)
  assert.equal(formatInstant(session.archiveTime), '—')
})

test('client model surfaces archive compatibility and every delete blocker', () => {
  assert.equal(archiveCapabilityMessage(capabilities, 1), null)
  assert.match(archiveCapabilityMessage(capabilities, 2) ?? '', /批量归档回滚能力/)
  assert.deepEqual(blockerRows({ code: 'blocked', message: 'no', details: { blockers: [
    { id: 'run', status: 'running' }, { id: 'legacy', status: 'attached-legacy' },
    { id: 'config', status: 'config-identity' }, { nope: true },
  ] } }), [
    { id: 'run', status: 'running' }, { id: 'legacy', status: 'attached-legacy' },
    { id: 'config', status: 'config-identity' },
  ])
  assert.equal(statusLabel('running'), '运行中')
  assert.equal(statusLabel('config-identity'), '配置绑定（重启会重建）')
  assert.equal(statusLabel('deletion-reserved'), '正在被其他删除事务处理')
  assert.equal(statusLabel('disposal-failed'), '停止 Agent 失败')
})
