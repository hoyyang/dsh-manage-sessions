import { test } from 'node:test'
import assert from 'node:assert/strict'

const STORE_KEY = '__dshSessionManagerUiStore__'

async function generation(name: string) {
  return import(`../src/client/store.js?generation=${name}-${Date.now()}-${Math.random()}`)
}

test('independent HMR generations share manager state and notifications', async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  const headerGeneration = await generation('header')
  const overlayGeneration = await generation('overlay')
  let notifications = 0
  const unsubscribe = overlayGeneration.subscribeManager(() => { notifications += 1 })

  headerGeneration.openManager(null)
  assert.equal(notifications, 1)
  assert.equal(overlayGeneration.getManagerSnapshot().open, true)
  assert.deepEqual(overlayGeneration.getManagerSnapshot().intent, { kind: 'manager' })

  overlayGeneration.closeManager()
  assert.equal(notifications, 2)
  assert.equal(headerGeneration.getManagerSnapshot().open, false)

  unsubscribe()
  headerGeneration.resetManagerStore()
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
})

test('new overlay generation observes an already-open old header generation', async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  const oldHeader = await generation('old-header')
  oldHeader.openSingleDelete('session-1', 'Session 1', null)

  const newOverlay = await generation('new-overlay')
  assert.equal(newOverlay.getManagerSnapshot().open, true)
  assert.deepEqual(newOverlay.getManagerSnapshot().intent, { kind: 'delete', id: 'session-1', title: 'Session 1' })

  newOverlay.resetManagerStore()
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
})

test('overlapping slot owners clean transient intent only after final unload', async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  const oldGeneration = await generation('old-overlay')
  const newGeneration = await generation('new-overlay')
  const disposeOld = oldGeneration.mountManagerStore()
  const disposeNew = newGeneration.mountManagerStore()
  oldGeneration.openManager(null)

  disposeOld()
  assert.equal(newGeneration.getManagerAvailabilitySnapshot(), true)
  assert.equal(newGeneration.getManagerSnapshot().open, true)

  disposeNew()
  assert.equal(oldGeneration.getManagerAvailabilitySnapshot(), false)
  assert.equal(oldGeneration.getManagerSnapshot().open, false)
  assert.equal(oldGeneration.getManagerSnapshot().intent, null)
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
})

test('installed non-overlap HMR resets pending intent then accepts a fresh cross-generation open', async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  const oldGeneration = await generation('installed-old')
  const disposeOld = oldGeneration.mountManagerStore()
  oldGeneration.openSingleDelete('session-1', 'Session 1', null)

  disposeOld()
  assert.equal(oldGeneration.getManagerAvailabilitySnapshot(), false)
  assert.equal(oldGeneration.getManagerSnapshot().intent, null)

  const newGeneration = await generation('installed-new')
  const disposeNew = newGeneration.mountManagerStore()
  oldGeneration.openManager(null)
  assert.equal(newGeneration.getManagerAvailabilitySnapshot(), true)
  assert.deepEqual(newGeneration.getManagerSnapshot().intent, { kind: 'manager' })

  disposeNew()
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
})

test('header availability subscription survives overlay loss and later recovery', async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  const headerGeneration = await generation('availability-header')
  const overlayGeneration = await generation('availability-overlay')
  const availability: boolean[] = []
  const unsubscribe = headerGeneration.subscribeManager(() => {
    availability.push(headerGeneration.getManagerAvailabilitySnapshot())
  })

  const disposeFirst = overlayGeneration.mountManagerStore()
  disposeFirst()
  const disposeSecond = overlayGeneration.mountManagerStore()
  disposeSecond()

  assert.deepEqual(availability, [true, false, true, false])
  unsubscribe()
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
})
