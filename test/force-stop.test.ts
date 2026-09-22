import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHost, mkTmp } from './helpers.ts'
import type { CallRec } from './helpers.ts'
import { probeCapabilities } from '../src/capabilities.ts'
import { SessionManagerService } from '../src/session-service.ts'
import { PluginStateStore } from '../src/state.ts'
import type { HostAgents, HostServices } from '../src/types.ts'

interface ForceBehavior {
  cancelConverges?: boolean
  resetConverges?: boolean
  resume?: boolean
}

/**
 * Attach a scriptable force-stop fixture onto a makeHost agents service.
 * `initial` maps session id → running state; behavior switches decide which
 * escalation tier converges (mirrors a hung agent that ignores abort signals).
 */
function attachForce(
  host: HostServices,
  initial: Record<string, { running: boolean }>,
  behavior: ForceBehavior = {},
): { cancels: Array<{ id: string; keepInbox: boolean }> } {
  const agents = host.agents as HostAgents
  const state = new Map(Object.entries(initial).map(([id, value]) => [id, { ...value }]))
  const cancels: Array<{ id: string; keepInbox: boolean }> = []
  agents.stop = (id, keepInbox) => {
    cancels.push({ id, keepInbox })
    if (behavior.cancelConverges === true && state.get(id)?.running === true) state.get(id)!.running = false
  }
  agents.peek = (id) => {
    const entry = state.get(id)
    return entry === undefined
      ? { attached: false, running: false, inbox: null, subagent: false }
      : { attached: true, running: entry.running, inbox: 2, subagent: false }
  }
  agents.phaseReset = (id) => {
    if (behavior.resetConverges === true && state.get(id) !== undefined) state.get(id)!.running = false
  }
  if (behavior.resume === true) {
    agents.resumeSession = async (id) => { state.set(id, { running: false }) }
  }
  return { cancels }
}

async function serviceWith(host: HostServices): Promise<SessionManagerService> {
  return new SessionManagerService(host, await PluginStateStore.open(await mkTmp()))
}

const TINY = { pollMs: 1, cancelMs: 20, resetMs: 20 }

test('forceStop fails closed without the force surface', async () => {
  const calls: CallRec[] = []
  const service = await serviceWith(makeHost({ calls }))
  const result = await service.forceStop('session-a', 'resume', TINY)
  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.error.code, 'capability-missing')
})

test('forceStop validates id and mode', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  attachForce(host, {})
  const service = await serviceWith(host)
  const badId = await service.forceStop('', 'resume', TINY)
  assert.equal(badId.ok ? null : badId.error.code, 'invalid-request')
  const badMode = await service.forceStop('session-a', 'explode', TINY)
  assert.equal(badMode.ok ? null : badMode.error.code, 'invalid-request')
})

test('offline mode on an unattached session is an honest no-op', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  attachForce(host, {})
  const service = await serviceWith(host)
  const result = await service.forceStop('ghost-session', 'offline', TINY)
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.stoppedVia : null, 'not-running')
  assert.equal(result.ok ? result.attached : null, false)
  assert.equal(result.ok ? result.resumed : null, false)
})

test('resume mode materializes an offline session', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  attachForce(host, {}, { resume: true })
  const service = await serviceWith(host)
  const result = await service.forceStop('session-a', 'resume', TINY)
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.resumed : null, true)
  assert.equal(result.ok ? result.attached : null, true)
  assert.equal(calls.filter((call) => call.op === 'resume').length, 0) // fixture resume is not a recorded host call
})

test('cancel tier converges and keeps the inbox in resume mode', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  const { cancels } = attachForce(host, { 'session-a': { running: true } }, { cancelConverges: true, resume: true })
  const service = await serviceWith(host)
  const result = await service.forceStop('session-a', 'resume', TINY)
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.stoppedVia : null, 'cancel')
  assert.equal(result.ok ? result.inboxAtStop : null, 2)
  assert.equal(result.ok ? result.resumed : null, true)
  assert.deepEqual(cancels, [{ id: 'session-a', keepInbox: true }])
})

test('offline mode abandons the in-memory inbox queue', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  const { cancels } = attachForce(host, { 'session-a': { running: true } }, { cancelConverges: true })
  const service = await serviceWith(host)
  const result = await service.forceStop('session-a', 'offline', TINY)
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.resumed : null, false)
  assert.deepEqual(cancels, [{ id: 'session-a', keepInbox: false }])
})

test('phase reset converges when the agent ignores the cancel signal', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  attachForce(host, { 'session-a': { running: true } }, { resetConverges: true, resume: true })
  const service = await serviceWith(host)
  const result = await service.forceStop('session-a', 'resume', TINY)
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.stoppedVia : null, 'phase-reset')
  // The machine stays attached and alive; auto-resume keeps it live for the
  // queued messages (processed with the user's next send).
  assert.equal(result.ok ? result.attached : null, true)
  assert.equal(result.ok ? result.resumed : null, true)
  assert.deepEqual(result.ok ? result.trace : [], ['cancel', 'phase-reset'])
})

test('escalates to phase reset as the last resort and reports the trace', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  attachForce(host, { 'session-a': { running: true } }, { resetConverges: true })
  const service = await serviceWith(host)
  const result = await service.forceStop('session-a', 'offline', TINY)
  assert.equal(result.ok, true)
  assert.equal(result.ok ? result.stoppedVia : null, 'phase-reset')
  assert.deepEqual(result.ok ? result.trace : [], ['cancel', 'phase-reset'])
})

test('reports an honest failure when nothing converges', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  attachForce(host, { 'session-a': { running: true } }, {})
  const service = await serviceWith(host)
  const result = await service.forceStop('session-a', 'offline', TINY)
  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.error.code, 'force-stop-failed')
  assert.deepEqual(result.ok ? null : (result.error.details?.trace as unknown), ['cancel', 'phase-reset'])
})

test('resume failure on an offline session fails loud', async () => {
  const calls: CallRec[] = []
  const host = makeHost({ calls })
  attachForce(host, {})
  host.agents!.resumeSession = async () => { throw new Error('resume-boom') }
  const service = await serviceWith(host)
  const result = await service.forceStop('session-a', 'resume', TINY)
  assert.equal(result.ok, false)
  assert.equal(result.ok ? null : result.error.code, 'force-stop-failed')
  assert.deepEqual(result.ok ? null : (result.error.details?.trace as unknown), ['resume'])
})

test('probeCapabilities lights forceStop only with the full surface', () => {
  const calls: CallRec[] = []
  const bare = makeHost({ calls })
  assert.equal(probeCapabilities(bare, true).forceStop, false)
  attachForce(bare, {})
  const caps = probeCapabilities(bare, true)
  assert.equal(caps.forceStop, true)
  assert.equal(caps.forceStopResume, false)
  bare.agents!.resumeSession = async () => {}
  assert.equal(probeCapabilities(bare, true).forceStopResume, true)
})
