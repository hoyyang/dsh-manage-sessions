# dsh-manage-sessions

![banner](assets/banner.png)

Native-feeling session management for the DSH sidebar: **bulk archive / restore / hard-delete, one-click force-stop with auto-resume for stuck agents, and instant copy-workspace-path** — all inside the official DSH UI.

[**中文**](README.md) · [Releases](https://github.com/hoyyang/dsh-manage-sessions/releases) · [Changelog](CHANGELOG.md)

<p align="center">
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.1-blue" alt="dsh version">
  <a href="https://www.npmjs.com/package/dsh-manage-sessions"><img src="https://img.shields.io/npm/v/dsh-manage-sessions" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  <a href="https://github.com/hoyyang/dsh-manage-sessions/stargazers"><img src="https://img.shields.io/github/stars/hoyyang/dsh-manage-sessions?style=social" alt="stars"></a>
</p>

## Install

```bash
dsh plugin add github:hoyyang/dsh-manage-sessions
# or npm
dsh plugin add dsh-manage-sessions
```

**Zero config**. Requires DSH `0.1.5-rc.1` (other versions untested, unsupported).

## What you get

- **Bulk manager overlay**: an entry next to the sidebar "Workspaces" title opens a workspace-grouped session list — **multi-select bulk archive / restore / hard delete**, with context pressure, token usage, execution stats and last activity. Destructive batches require explicit confirmation and list every blocker.
- **Two-stage force-stop**: when an agent hangs and the official stop button does nothing, the **⟳|⏻** segmented group in the session header stops it — **⟳ auto-resume** (resume immediately, queued messages kept) or **⏻ leave offline**. L1 official cancel → verify → L2 phase reset, fully traced, never fakes success.
- **Copy workspace path**: hover a workspace row and a native-styled button appears left of the ⋯ / + pair — click to **instantly** copy the workspace's absolute path (42 ms measured), with a ✓ flash and a toast showing the full path.
- **Double-click rename**: double-click a session row to open the official rename dialog (drives the native menu path).

How it differs: force-stop uses staged escalation and deliberately **does not** detach agent scopes (measured to kill the host machine); copy-path reads the workspace registry directly and **does not** scan all sessions; every sidebar injection appends only — official DOM children are never touched.

## 30-second tour

1. Install; a manager icon appears right of the "Workspaces" sidebar title.
2. Click it, select sessions, hit Archive.
3. Hover any workspace row, click the left-most button — the absolute path is in your clipboard.
4. A stuck session? Hit **⟳** in its header: force-stop then auto-resume.
5. Double-click any session row to rename via the official dialog.

## Advanced

**Hard delete** relies on a set of core compatibility patches (the installer prompts automatically). After a DSH upgrade or reinstall, re-apply:

```bash
node scripts/core-patch.mjs --check
node scripts/core-patch.mjs --apply
node scripts/core-patch.mjs --revert
```

Without the patch, hard delete fails closed (the UI says so) and everything else keeps working.

## How it works

The manager overlay reads the official `useSessions` / `useWorkspaces` runtime hooks (same canonical source as the home page). Copy-path goes through the plugin's own loopback-only HTTP route `/dsh-manage-sessions/workspaces` (registry direct read, no session scans). Force-stop walks the agents contract (cancel → phase reset) in stages. Sidebar augmentation mounts via official slots plus append-only bridges — nothing official is mutated, and uninstalling restores the stock UI.

## Reliability

- **99/99** unit tests (node:test: transport gates, force-stop escalation, copy bridge, entry bridge, state migration);
- dual-tsconfig typecheck and cold-start static checks (junctions, bundle manifests, route collisions, client registration ids) all green;
- force-stop / copy / bulk delete verified against a live instance (not mocks).

## FAQ

**Hard delete is greyed out?** Run `node scripts/core-patch.mjs --check && --apply` and restart DSH.
**Does force-stop lose messages?** Auto-resume keeps queued messages; leave-offline drops the in-memory queue (session logs are kept).
**No copy button?** The ungrouped bucket has no path and gets no button; if a real workspace row still lacks it after a refresh, please file an issue.

## Build from source

```bash
npm ci
npm run build && npm test
```

## License

[MIT](LICENSE)
