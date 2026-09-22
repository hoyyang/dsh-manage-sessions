import { test } from 'node:test'
import assert from 'node:assert/strict'
import AgentRegistry from '@deepseek-ai/dsh-agent'

const proto = AgentRegistry.prototype as unknown as Record<string, (...args: unknown[]) => unknown>

function owner(live = new Map<string, { id: string; status: string }>()) {
  const value = {
    deletionReservations: new Map<string, string>(),
    deletionProtections: new Map<string, number>(),
    disposalHandles: new Map<string, { agent: unknown; dispose(): Promise<void> }>(),
    nextDeletionReservation: 0,
    get: (id: string) => live.get(id),
  } as Record<string, unknown>
  value.sessionDisposalStatus = (id: string) => proto.sessionDisposalStatus.call(value, id)
  value.assertSessionNotReserved = (id: string) => proto.assertSessionNotReserved.call(value, id)
  value.releaseSessionDeletionReservation = (token: string) => proto.releaseSessionDeletionReservation.call(value, token)
  return value
}

test('installed agent core lease blocks create, resume, and final enter publication until release', async () => {
  const value = owner()
  const result = await proto.reserveSessionsForDeletion.call(value, ['cold-session']) as { ok: true; reservationToken: string }
  assert.equal(result.ok, true)
  assert.equal(proto.sessionDisposalStatus.call(value, 'cold-session'), 'deletion-reserved')

  await assert.rejects(
    proto.create.call(value, { sessionId: 'cold-session' }) as Promise<unknown>,
    /reserved for permanent deletion/,
  )
  await assert.rejects(
    proto.resume.call(value, { resumeSessionId: 'cold-session' }) as Promise<unknown>,
    /reserved for permanent deletion/,
  )
  assert.throws(
    () => proto.enter.call(value, { id: 'cold-session', session: { id: 'cold-session' } }, undefined),
    /reserved for permanent deletion/,
  )

  proto.releaseSessionDeletionReservation.call(value, result.reservationToken)
  assert.equal(proto.sessionDisposalStatus.call(value, 'cold-session'), 'cold')
})

test('installed agent core rejects cold config identities and releases protection idempotently', async () => {
  const value = owner()
  const release = proto.protectSessionDeletionIds.call(value, ['configured-session']) as () => void
  assert.equal(proto.sessionDisposalStatus.call(value, 'configured-session'), 'config-identity')
  const result = await proto.reserveSessionsForDeletion.call(value, ['configured-session']) as { ok: false; blockers: unknown[] }
  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, [{ id: 'configured-session', status: 'config-identity' }])
  release()
  release()
  assert.equal(proto.sessionDisposalStatus.call(value, 'configured-session'), 'cold')
})

test('installed agent core observes every teardown and releases the whole lease on one failure', async () => {
  const a = { id: 'a', status: 'idle' }
  const b = { id: 'b', status: 'idle' }
  const live = new Map([['a', a], ['b', b]])
  const value = owner(live)
  const calls: string[] = []
  ;(value.disposalHandles as Map<string, unknown>).set('a', {
    agent: a,
    dispose: async () => { calls.push('a'); throw new Error('a-failed') },
  })
  ;(value.disposalHandles as Map<string, unknown>).set('b', {
    agent: b,
    dispose: async () => { calls.push('b') },
  })

  const result = await proto.reserveSessionsForDeletion.call(value, ['a', 'b']) as { ok: false; blockers: unknown[] }
  assert.equal(result.ok, false)
  assert.deepEqual(calls.sort(), ['a', 'b'])
  assert.deepEqual(result.blockers, [{ id: 'a', status: 'disposal-failed', cause: 'a-failed' }])
  assert.equal((value.deletionReservations as Map<string, string>).size, 0)
})
