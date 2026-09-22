#!/usr/bin/env node
import { access, copyFile, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

/**
 * Every DSH version whose compiled core files still carry the exact anchors
 * below. Anchors are re-verified per entry; an unknown version is refused
 * loudly instead of being patched on a guess.
 */
const SUPPORTED_VERSIONS = ['0.1.5-rc.1']
const BACKUP_SUFFIX = '.dsh-manage-sessions.bak'
const MARKER = 'DSH_SESSION_MANAGER_CORE_PATCH_V1'
const DEFAULT_DSH = process.env.DSH_CHECKOUT || os.homedir() + '/.npm-global/lib/node_modules/@deepseek-ai/dsh'

const mode = process.argv[2] ?? '--check'
if (!['--check', '--apply', '--revert'].includes(mode)) {
  console.error('usage: node scripts/core-patch.mjs [--check|--apply|--revert]')
  process.exit(2)
}

const dshRoot = await resolveDshRoot()
const modules = join(dshRoot, 'node_modules', '@deepseek-ai')

const patches = [
  {
    packageDir: 'dsh-agent',
    file: 'lib/index.js',
    replacements: [
      {
        before: `var AgentRegistry = class extends Service {\n\tstore = /* @__PURE__ */ new Map();\n\tfactory;`,
        legacyAfter: `var AgentRegistry = class extends Service {\n\t/* ${MARKER}: retain the same owner handles for lifecycle-safe administrative retirement. */\n\tstore = /* @__PURE__ */ new Map();\n\tdisposalHandles = /* @__PURE__ */ new Map();\n\tfactory;`,
        after: `var AgentRegistry = class extends Service {\n\t/* ${MARKER}: owner handles plus an atomic writer-exclusion lease for permanent deletion. */\n\tstore = /* @__PURE__ */ new Map();\n\tdisposalHandles = /* @__PURE__ */ new Map();\n\tdeletionReservations = /* @__PURE__ */ new Map();\n\tdeletionProtections = /* @__PURE__ */ new Map();\n\tnextDeletionReservation = 0;\n\tfactory;`
      },
      {
        before: `\t\tctx.on("internal/status", (fiber) => {\n\t\t\tif (fiber.state === 5 && this.hasLifecycleAncestor(fiber)) this.closeInitiators();\n\t\t});\n\t\tctx.effect(function* () {`,
        after: `\t\tctx.on("internal/status", (fiber) => {\n\t\t\tif (fiber.state === 5 && this.hasLifecycleAncestor(fiber)) this.closeInitiators();\n\t\t});\n\t\tctx.on("agent/disposed", ({ agent }) => {\n\t\t\tconst handle = this.disposalHandles.get(agent.id);\n\t\t\tif (handle?.agent === agent) this.disposalHandles.delete(agent.id);\n\t\t});\n\t\tctx.effect(function* () {`
      },
      {
        before: `\tasync create(options) {\n\t\tconst ownerCtx = this.ctx;\n\t\tconst { target } = this.requireFactory();\n\t\tconst receiver = getTraceable(ownerCtx, target);\n\t\treturn Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);\n\t}`,
        legacyAfter: `\tasync create(options) {\n\t\tconst ownerCtx = this.ctx;\n\t\tconst { target } = this.requireFactory();\n\t\tconst receiver = getTraceable(ownerCtx, target);\n\t\treturn this.retainDisposalHandle(await Reflect.apply(target.createAgent, receiver, [ownerCtx, options]));\n\t}`,
        after: `\tasync create(options) {\n\t\tthis.assertSessionNotReserved(options.sessionId);\n\t\tconst ownerCtx = this.ctx;\n\t\tconst { target } = this.requireFactory();\n\t\tconst receiver = getTraceable(ownerCtx, target);\n\t\treturn this.retainDisposalHandle(await Reflect.apply(target.createAgent, receiver, [ownerCtx, options]));\n\t}`
      },
      {
        before: `\tasync resume(options) {\n\t\tconst ownerCtx = this.ctx;\n\t\tconst { target } = this.requireFactory();\n\t\tconst receiver = getTraceable(ownerCtx, target);\n\t\treturn Reflect.apply(target.resume, receiver, [ownerCtx, options]);\n\t}\n\t/**\n\t* Register a live agent.`,
        legacyAfter: `\tasync resume(options) {\n\t\tconst ownerCtx = this.ctx;\n\t\tconst { target } = this.requireFactory();\n\t\tconst receiver = getTraceable(ownerCtx, target);\n\t\treturn this.retainDisposalHandle(await Reflect.apply(target.resume, receiver, [ownerCtx, options]));\n\t}\n\t/** Retain and return the exact owner capability without changing handle identity or semantics. */\n\tretainDisposalHandle(handle) {\n\t\tthis.disposalHandles.set(handle.agent.id, handle);\n\t\treturn handle;\n\t}\n\t/** Describe whether one session can be retired through an exact retained owner capability. */\n\tsessionDisposalStatus(id) {\n\t\tconst agent = this.get(id);\n\t\tif (agent === void 0) return "cold";\n\t\tif (agent.status === "running") return "running";\n\t\treturn this.disposalHandles.get(id)?.agent === agent ? "idle" : "attached-legacy";\n\t}\n\t/**\n\t* Atomically preflight a batch, then initiate every admitted idle teardown before awaiting.\n\t* A running or unowned live member rejects the whole batch without disposing any member.\n\t*/\n\tasync disposeSessions(ids) {\n\t\tconst unique = [...new Set(ids)];\n\t\tconst statuses = unique.map((id) => ({ id, status: this.sessionDisposalStatus(id) }));\n\t\tconst blockers = statuses.filter(({ status }) => status === "running" || status === "attached-legacy");\n\t\tif (blockers.length > 0) return {\n\t\t\tok: false,\n\t\t\tblockers\n\t\t};\n\t\tconst live = statuses.flatMap(({ id, status }) => status === "idle" ? [{\n\t\t\tid,\n\t\t\thandle: this.disposalHandles.get(id)\n\t\t}] : []);\n\t\tconst retirements = live.map(({ handle }) => handle.dispose());\n\t\tawait Promise.all(retirements);\n\t\treturn {\n\t\t\tok: true,\n\t\t\tdisposedIds: live.map(({ id }) => id)\n\t\t};\n\t}\n\t/**\n\t* Register a live agent.`,
        after: `\tasync resume(options) {\n\t\tthis.assertSessionNotReserved(options.resumeSessionId);\n\t\tconst ownerCtx = this.ctx;\n\t\tconst { target } = this.requireFactory();\n\t\tconst receiver = getTraceable(ownerCtx, target);\n\t\treturn this.retainDisposalHandle(await Reflect.apply(target.resume, receiver, [ownerCtx, options]));\n\t}\n\t/** Retain and return the exact owner capability without changing handle identity or semantics. */\n\tretainDisposalHandle(handle) {\n\t\tthis.disposalHandles.set(handle.agent.id, handle);\n\t\treturn handle;\n\t}\n\t/** Protect fixed config identities that AgentLoop would recreate after deletion. */\n\tprotectSessionDeletionIds(ids) {\n\t\tconst unique = [...new Set(ids)];\n\t\tconst conflicts = unique.filter((id) => this.deletionReservations.has(id));\n\t\tif (conflicts.length > 0) throw new Error(\`cannot protect sessions reserved for permanent deletion: \${conflicts.join(", ")}\`);\n\t\tfor (const id of unique) this.deletionProtections.set(id, (this.deletionProtections.get(id) ?? 0) + 1);\n\t\tlet active = true;\n\t\treturn () => {\n\t\t\tif (!active) return;\n\t\t\tactive = false;\n\t\t\tfor (const id of unique) {\n\t\t\t\tconst count = this.deletionProtections.get(id) ?? 0;\n\t\t\t\tif (count <= 1) this.deletionProtections.delete(id);\n\t\t\t\telse this.deletionProtections.set(id, count - 1);\n\t\t\t}\n\t\t};\n\t}\n\t/** Reject every creation path before preparation and again at final publication. */\n\tassertSessionNotReserved(id) {\n\t\tif (this.deletionReservations.has(id)) throw new Error(\`session "\${id}" is reserved for permanent deletion\`);\n\t}\n\t/** Describe whether one session can enter an atomic deletion lease. */\n\tsessionDisposalStatus(id) {\n\t\tif (this.deletionProtections.has(id)) return "config-identity";\n\t\tif (this.deletionReservations.has(id)) return "deletion-reserved";\n\t\tconst agent = this.get(id);\n\t\tif (agent === void 0) return "cold";\n\t\tif (agent.status === "running") return "running";\n\t\treturn this.disposalHandles.get(id)?.agent === agent ? "idle" : "attached-legacy";\n\t}\n\t/** Atomically reserve a whole batch before draining every admitted owner handle. */\n\tasync reserveSessionsForDeletion(ids) {\n\t\tconst unique = [...new Set(ids)];\n\t\tconst statuses = unique.map((id) => ({ id, status: this.sessionDisposalStatus(id) }));\n\t\tconst blockers = statuses.filter(({ status }) => status !== "cold" && status !== "idle");\n\t\tif (blockers.length > 0) return { ok: false, blockers };\n\t\tconst token = "deletion-" + (++this.nextDeletionReservation);\n\t\tfor (const id of unique) this.deletionReservations.set(id, token);\n\t\tconst live = statuses.flatMap(({ id, status }) => status === "idle" ? [{ id, handle: this.disposalHandles.get(id) }] : []);\n\t\tconst settled = await Promise.allSettled(live.map(({ handle }) => Promise.resolve().then(() => handle.dispose())));\n\t\tconst failures = settled.flatMap((result, index) => result.status === "rejected" ? [{\n\t\t\tid: live[index].id,\n\t\t\tstatus: "disposal-failed",\n\t\t\tcause: result.reason instanceof Error ? result.reason.message : String(result.reason)\n\t\t}] : []);\n\t\tif (failures.length > 0) {\n\t\t\tthis.releaseSessionDeletionReservation(token);\n\t\t\treturn { ok: false, blockers: failures };\n\t\t}\n\t\treturn { ok: true, reservationToken: token, disposedIds: live.map(({ id }) => id) };\n\t}\n\t/** Release only ids owned by this opaque lease token; repeat calls are harmless. */\n\treleaseSessionDeletionReservation(token) {\n\t\tfor (const [id, owner] of this.deletionReservations) if (owner === token) this.deletionReservations.delete(id);\n\t}\n\t/**\n\t* Register a live agent.`
      },
      {
        upgradeClean: true,
        before: `\tenter(agent, owner) {\n\t\tconst id = agent.id;\n\t\tif (id !== agent.session.id) throw new Error(\`agent id "\${id}" does not match session id "\${agent.session.id}"\`);\n\t\tconst carrier = scopeTarget(agent, agent);`,
        after: `\tenter(agent, owner) {\n\t\tconst id = agent.id;\n\t\tif (id !== agent.session.id) throw new Error(\`agent id "\${id}" does not match session id "\${agent.session.id}"\`);\n\t\tthis.assertSessionNotReserved(id);\n\t\tconst carrier = scopeTarget(agent, agent);`
      }
    ]
  },
  {
    packageDir: 'dsh-agent',
    file: 'lib/types/index.d.ts',
    replacements: [
      {
        before: `export declare class AgentRegistry extends Service {\n    private store;\n    private factory;`,
        legacyAfter: `export type SessionDisposalStatus = 'cold' | 'idle' | 'running' | 'attached-legacy';\nexport type SessionDisposalResult = {\n    ok: true;\n    disposedIds: SessionId[];\n} | {\n    ok: false;\n    blockers: Array<{\n        id: SessionId;\n        status: 'running' | 'attached-legacy';\n    }>;\n};\nexport declare class AgentRegistry extends Service {\n    private store;\n    /** ${MARKER}: exact retained owner capabilities for administrative retirement. */\n    private disposalHandles;\n    private factory;`,
        after: `export type SessionDisposalStatus = 'cold' | 'idle' | 'running' | 'attached-legacy' | 'config-identity' | 'deletion-reserved';\nexport type SessionDisposalBlocker = {\n    id: SessionId;\n    status: Exclude<SessionDisposalStatus, 'cold' | 'idle'> | 'disposal-failed';\n    cause?: string;\n};\nexport type SessionDeletionReservationResult = {\n    ok: true;\n    reservationToken: string;\n    disposedIds: SessionId[];\n} | {\n    ok: false;\n    blockers: SessionDisposalBlocker[];\n};\nexport declare class AgentRegistry extends Service {\n    private store;\n    /** ${MARKER}: exact owner capabilities and atomic permanent-deletion reservations. */\n    private disposalHandles;\n    private deletionReservations;\n    private deletionProtections;\n    private nextDeletionReservation;\n    private factory;`
      },
      {
        before: `    resume(options: ResumeAgentOptions): Promise<AgentHandle>;\n    /**\n     * Register a live agent.`,
        legacyAfter: `    resume(options: ResumeAgentOptions): Promise<AgentHandle>;\n    /** Retain and return the exact owner capability without changing handle identity or semantics. */\n    private retainDisposalHandle;\n    /** Describe whether one session can be retired through an exact retained owner capability. */\n    sessionDisposalStatus(id: SessionId): SessionDisposalStatus;\n    /** Atomically preflight a batch, then initiate every admitted idle teardown before awaiting. */\n    disposeSessions(ids: readonly SessionId[]): Promise<SessionDisposalResult>;\n    /**\n     * Register a live agent.`,
        after: `    resume(options: ResumeAgentOptions): Promise<AgentHandle>;\n    /** Retain and return the exact owner capability without changing handle identity or semantics. */\n    private retainDisposalHandle;\n    /** Protect fixed config identities that AgentLoop would recreate after deletion. */\n    protectSessionDeletionIds(ids: readonly SessionId[]): () => void;\n    /** Reject every creation path before preparation and again at final publication. */\n    private assertSessionNotReserved;\n    /** Describe whether one session can enter an atomic deletion lease. */\n    sessionDisposalStatus(id: SessionId): SessionDisposalStatus;\n    /** Atomically reserve a whole batch before draining every admitted owner handle. */\n    reserveSessionsForDeletion(ids: readonly SessionId[]): Promise<SessionDeletionReservationResult>;\n    /** Release only ids owned by this opaque lease token; repeat calls are harmless. */\n    releaseSessionDeletionReservation(token: string): void;\n    /**\n     * Register a live agent.`
      }
    ]
  },
  {
    packageDir: 'dsh-agent-loop',
    file: 'lib/index.js',
    replacements: [
      {
        before: `\t\tvalidateConfiguredAgents(this.config.agents);\n\t\tctx.sessionProjections.register(turnBoundaryProjectionDefinition);\n\t\tthis.ownership = new FactoryOwnership(ctx.fiber);`,
        after: `\t\tvalidateConfiguredAgents(this.config.agents);\n\t\tconst protectedSessionIds = this.config.agents.flatMap(({ sessionId, resumeSessionId }) => [sessionId, resumeSessionId]).filter((id) => id !== void 0 && id !== "");\n\t\tctx.effect(() => ctx.agents.protectSessionDeletionIds(protectedSessionIds), "agentLoop.protectConfiguredSessionDeletion()");\n\t\tctx.sessionProjections.register(turnBoundaryProjectionDefinition);\n\t\tthis.ownership = new FactoryOwnership(ctx.fiber);`
      }
    ]
  },
  {
    packageDir: 'dsh-workspace',
    file: 'lib/index.js',
    replacements: [
      {
        before: `\tarchiveSession(sessionId) {\n\t\treturn this.enqueueOperation(async () => {\n\t\t\tif (this.requireState().archivedSessionIds.includes(sessionId)) return;\n\t\t\tif (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId);\n\t\t\tconst state = this.requireState();\n\t\t\tawait this.setState({\n\t\t\t\t...state,\n\t\t\t\tarchivedSessionIds: [...state.archivedSessionIds, sessionId]\n\t\t\t});\n\t\t});\n\t}\n\t/**\n\t* Whether a session is live, header-indexed, or present in a fresh`,
        legacyAfter: `\tarchiveSession(sessionId) {\n\t\treturn this.enqueueOperation(async () => {\n\t\t\tif (this.requireState().archivedSessionIds.includes(sessionId)) return;\n\t\t\tif (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId);\n\t\t\tconst state = this.requireState();\n\t\t\tawait this.setState({\n\t\t\t\t...state,\n\t\t\t\tarchivedSessionIds: [...state.archivedSessionIds, sessionId]\n\t\t\t});\n\t\t});\n\t}\n\t/** ${MARKER}: durably forget one session from every workspace account and archive metadata. */\n\tforgetSession(sessionId) {\n\t\treturn this.enqueueOperation(async () => {\n\t\t\tfor (const entity of this.entities.values()) await entity.detachSession(sessionId);\n\t\t\tconst state = this.requireState();\n\t\t\tif (state.archivedSessionIds.includes(sessionId)) await this.setState({\n\t\t\t\t...state,\n\t\t\t\tarchivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)\n\t\t\t});\n\t\t\tthis.headers.delete(sessionId);\n\t\t\tthis.sessionPaths.delete(sessionId);\n\t\t\tthis.invalidSessionPaths.delete(sessionId);\n\t\t});\n\t}\n\t/**\n\t* Whether a session is live, header-indexed, or present in a fresh`,
        after: `\tarchiveSession(sessionId) {\n\t\treturn this.enqueueOperation(async () => {\n\t\t\tif (this.requireState().archivedSessionIds.includes(sessionId)) return;\n\t\t\tif (!await this.sessionKnown(sessionId)) throw new WorkspaceUnknownSessionError(sessionId);\n\t\t\tconst state = this.requireState();\n\t\t\tawait this.setState({\n\t\t\t\t...state,\n\t\t\t\tarchivedSessionIds: [...state.archivedSessionIds, sessionId]\n\t\t\t});\n\t\t});\n\t}\n\t/** ${MARKER}: restore one archived session to all grouping surfaces without changing workspace accounting. */\n\tunarchiveSession(sessionId) {\n\t\treturn this.enqueueOperation(async () => {\n\t\t\tconst state = this.requireState();\n\t\t\tif (!state.archivedSessionIds.includes(sessionId)) return;\n\t\t\tawait this.setState({\n\t\t\t\t...state,\n\t\t\t\tarchivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)\n\t\t\t});\n\t\t});\n\t}\n\t/** ${MARKER}: durably forget one session from every workspace account and archive metadata. */\n\tforgetSession(sessionId) {\n\t\treturn this.enqueueOperation(async () => {\n\t\t\tfor (const entity of this.entities.values()) await entity.detachSession(sessionId);\n\t\t\tconst state = this.requireState();\n\t\t\tif (state.archivedSessionIds.includes(sessionId)) await this.setState({\n\t\t\t\t...state,\n\t\t\t\tarchivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)\n\t\t\t});\n\t\t\tthis.headers.delete(sessionId);\n\t\t\tthis.sessionPaths.delete(sessionId);\n\t\t\tthis.invalidSessionPaths.delete(sessionId);\n\t\t});\n\t}\n\t/**\n\t* Whether a session is live, header-indexed, or present in a fresh`
      }
    ]
  },
  {
    packageDir: 'dsh-workspace',
    file: 'lib/types/index.d.ts',
    replacements: [
      {
        before: `    archiveSession(sessionId: SessionId): Promise<void>;\n    /**\n     * Whether a session is live, header-indexed, or present in a fresh`,
        legacyAfter: `    archiveSession(sessionId: SessionId): Promise<void>;\n    /** ${MARKER}: durably forget one session from every workspace account and archive metadata. */\n    forgetSession(sessionId: SessionId): Promise<void>;\n    /**\n     * Whether a session is live, header-indexed, or present in a fresh`,
        after: `    archiveSession(sessionId: SessionId): Promise<void>;\n    /** ${MARKER}: restore one archived session without changing workspace accounting. */\n    unarchiveSession(sessionId: SessionId): Promise<void>;\n    /** ${MARKER}: durably forget one session from every workspace account and archive metadata. */\n    forgetSession(sessionId: SessionId): Promise<void>;\n    /**\n     * Whether a session is live, header-indexed, or present in a fresh`
      }
    ]
  },
]

const results = []
for (const patch of patches) {
  const packageRoot = join(modules, patch.packageDir)
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (!SUPPORTED_VERSIONS.includes(packageJson.version)) {
    throw new Error(`${packageJson.name}: unsupported DSH version ${packageJson.version} (supported: ${SUPPORTED_VERSIONS.join(', ')})`)
  }
  const path = join(packageRoot, patch.file)
  const original = await readFile(path, 'utf8')
  const state = classify(original, patch)
  if (mode === '--check') {
    results.push({ path, state })
    continue
  }
  if (mode === '--apply') {
    if (state === 'applied') {
      results.push({ path, state: 'already-applied' })
      continue
    }
    if (state === 'upgradeable-v1') {
      const next = transformUpgrade(original, patch.replacements, path)
      await writeFile(path, next, 'utf8')
      results.push({ path, state: 'upgraded' })
      continue
    }
    if (state !== 'clean') throw new Error(`${path}: cannot apply from state ${state}`)
    const backup = `${path}${BACKUP_SUFFIX}`
    try {
      await access(backup)
    } catch {
      await copyFile(path, backup)
    }
    const next = transform(original, patch.replacements, 'before', 'after', path)
    await writeFile(path, next, 'utf8')
    results.push({ path, state: 'applied' })
    continue
  }
  if (state === 'clean') {
    results.push({ path, state: 'already-clean' })
    continue
  }
  if (state !== 'applied') throw new Error(`${path}: cannot revert from state ${state}`)
  const next = transform(original, [...patch.replacements].reverse(), 'after', 'before', path)
  await writeFile(path, next, 'utf8')
  results.push({ path, state: 'reverted' })
}

for (const result of results) console.log(`${result.state.padEnd(15)} ${result.path}`)
if (mode === '--check' && results.some(({ state }) => state.startsWith('invalid') || state.startsWith('mixed'))) process.exitCode = 1

function classify(content, patch) {
  let clean = 0
  let applied = 0
  let legacy = 0
  let upgradeClean = 0
  for (const replacement of patch.replacements) {
    const beforeCount = count(content, replacement.before)
    const afterCount = count(content, replacement.after)
    const legacyCount = typeof replacement.legacyAfter === 'string' ? count(content, replacement.legacyAfter) : 0
    // An after anchor may intentionally contain the shorter before anchor. The
    // complete transformed anchor is authoritative whenever it occurs once.
    if (afterCount === 1) applied += 1
    else if (legacyCount === 1) legacy += 1
    else if (afterCount === 0 && beforeCount === 1) {
      clean += 1
      if (replacement.upgradeClean === true) upgradeClean += 1
    } else return `invalid(anchor before=${beforeCount}, after=${afterCount}, legacy=${legacyCount})`
  }
  if (clean === patch.replacements.length) return 'clean'
  if (applied === patch.replacements.length) return 'applied'
  const migrating = legacy + upgradeClean
  if (migrating > 0 && applied + migrating === patch.replacements.length) return 'upgradeable-v1'
  return `mixed(clean=${clean}, applied=${applied}, legacy=${legacy}, upgradeClean=${upgradeClean})`
}

function transformUpgrade(content, replacements, path) {
  let next = content
  for (const replacement of replacements) {
    if (count(next, replacement.after) === 1) continue
    const from = typeof replacement.legacyAfter === 'string' && count(next, replacement.legacyAfter) === 1
      ? 'legacyAfter'
      : replacement.upgradeClean === true && count(next, replacement.before) === 1
        ? 'before'
        : null
    if (from === null) throw new Error(`${path}: V1 upgrade anchor is not uniquely recognized`)
    next = next.replace(replacement[from], replacement.after)
  }
  return next
}

function transform(content, replacements, from, to, path) {
  let next = content
  for (const replacement of replacements) {
    const occurrences = count(next, replacement[from])
    if (occurrences !== 1) throw new Error(`${path}: expected exactly one ${from} anchor, found ${occurrences}`)
    next = next.replace(replacement[from], replacement[to])
  }
  return next
}

function count(haystack, needle) {
  if (needle.length === 0) return 0
  let total = 0
  let cursor = 0
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    total += 1
    cursor += needle.length
  }
  return total
}

async function resolveDshRoot() {
  const candidates = [process.env.DSH_CHECKOUT, DEFAULT_DSH].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
      if (pkg.name === '@deepseek-ai/dsh') return candidate
    } catch {}
  }
  throw new Error(`unable to locate @deepseek-ai/dsh (checked ${candidates.join(', ')})`)
}
