#!/usr/bin/env node
/**
 * Junction-link development dependencies for typecheck/build/test:
 * - host packages come from the exact installed DSH package set;
 * - browser-only compile aids come from the existing pinned dsh-mall dev tree
 *   (0.1.5 no longer ships react/react-dom/ui-primitives at the install root);
 * - no package is downloaded and runtime resolution remains host-owned.
 *
 * Links inside @deepseek-ai and @types are per-package (not a whole-scope
 * symlink), so adding browser-only typings can never mutate the installed DSH.
 */
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')
const DEFAULT_DSH = process.env.DSH_CHECKOUT || join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh')
const LOCAL_TYPESCRIPT = process.env.LOCAL_TYPESCRIPT || join(homedir(), '.npm/_npx/168dd38e62c6bdfa/node_modules/typescript')
const CLIENT_DEPS = process.env.DSH_CLIENT_DEV_DEPS ?? join(dirname(ROOT), 'dsh-mall', 'node_modules')

async function exists(p) {
  try { await realpath(p); return true } catch { return false }
}

async function isDirectory(p) {
  try { return (await lstat(p)).isDirectory() } catch { return false }
}

async function ensureRealDirectory(path) {
  try {
    const stat = await lstat(path)
    if (stat.isDirectory() && !stat.isSymbolicLink()) return
    await rm(path, { force: true, recursive: true })
  } catch {}
  await mkdir(path, { recursive: true })
}

async function ensureLink(target, linkPath) {
  if (!await exists(target)) throw new Error(`development dependency is unavailable: ${target}`)
  // lstat, not realpath: a link left dangling by a host upgrade still occupies
  // the path, and symlinking over it fails with EEXIST.
  if (await existsByLstat(linkPath)) {
    const current = await realpath(linkPath).catch(() => null)
    if (current !== null && resolve(current) === resolve(target)) return 'exists'
    await rm(linkPath, { force: true, recursive: true })
  }
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(target, linkPath, await isDirectory(target) ? 'junction' : 'file').catch(() => symlink(target, linkPath))
  return 'linked'
}

async function existsByLstat(path) {
  try { await lstat(path); return true } catch { return false }
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

const dshRoot = await resolveDshRoot()
const dshModules = join(dshRoot, 'node_modules', '@deepseek-ai')
const ourModules = join(ROOT, 'node_modules', '@deepseek-ai')
const ourTypes = join(ROOT, 'node_modules', '@types')
const ourBin = join(ROOT, 'node_modules', '.bin')
const results = []

results.push(['typescript', 'typescript', await ensureLink(LOCAL_TYPESCRIPT, join(ROOT, 'node_modules', 'typescript'))])
results.push(['.bin/tsc', 'tsc', await ensureLink(join(LOCAL_TYPESCRIPT, 'bin', 'tsc'), join(ourBin, 'tsc'))])
results.push(['.bin/tsserver', 'tsserver', await ensureLink(join(LOCAL_TYPESCRIPT, 'bin', 'tsserver'), join(ourBin, 'tsserver'))])

await ensureRealDirectory(ourModules)
for (const entry of await readdir(dshModules, { withFileTypes: true })) {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
  await ensureLink(join(dshModules, entry.name), join(ourModules, entry.name))
}
results.push(['@deepseek-ai', 'installed DSH package links', 'linked'])
results.push(['ui-primitives', 'rc.7 structural compile aid', await ensureLink(
  join(CLIENT_DEPS, '@deepseek-ai', 'dsh-client-ui-primitives'),
  join(ourModules, 'dsh-client-ui-primitives'),
)])

await ensureRealDirectory(ourTypes)
results.push(['@types/node', 'node', await ensureLink(join(dshRoot, 'node_modules', '@types', 'node'), join(ourTypes, 'node'))])
results.push(['@types/react', 'react', await ensureLink(join(CLIENT_DEPS, '@types', 'react'), join(ourTypes, 'react'))])
results.push(['@types/react-dom', 'react-dom', await ensureLink(join(CLIENT_DEPS, '@types', 'react-dom'), join(ourTypes, 'react-dom'))])
results.push(['react', '18.3.1', await ensureLink(join(CLIENT_DEPS, 'react'), join(ROOT, 'node_modules', 'react'))])
results.push(['react-dom', '18.3.1', await ensureLink(join(CLIENT_DEPS, 'react-dom'), join(ROOT, 'node_modules', 'react-dom'))])
results.push(['tsdown', '0.22.2', await ensureLink(join(CLIENT_DEPS, 'tsdown'), join(ROOT, 'node_modules', 'tsdown'))])
results.push(['.bin/tsdown', 'tsdown', await ensureLink(join(CLIENT_DEPS, '.bin', 'tsdown'), join(ourBin, 'tsdown'))])

for (const [label, name, state] of results) {
  console.log(state.padEnd(8), label, '->', name)
}
