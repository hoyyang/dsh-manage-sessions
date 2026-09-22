# dsh-manage-sessions

![banner](assets/banner.png)

Native-feeling session management for the DSH sidebar: **bulk archive / restore / hard-delete, two-stage force-stop with auto-resume for stuck agents, and instant copy-workspace-path** — all inside the official DSH UI.

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
```

```bash
dsh plugin add dsh-manage-sessions
```

**Zero config, works out of the box**. Requires DSH `0.1.5-rc.1` (other versions untested, unsupported).

## What you get

- **Manager overlay**: an entry next to the sidebar "Workspaces" title opens a workspace-grouped manager window.
- **Bulk archive**: multi-select sessions and archive them in one click; cold sessions leave the main list instantly.
- **Bulk restore**: multi-select inside the archive bucket and bring sessions back to their workspace groups.
- **Bulk hard delete**: multi-select permanent delete with forced confirmation and a full blocker list.
- **Two-stage force-stop**: when an agent hangs and the official stop does nothing, the header ⟳|⏻ group stops it.
- **Force-stop with auto-resume**: ⟳ stops and immediately resumes; queued messages are kept.
- **Force-stop to offline**: ⏻ stops and leaves the session offline; session logs stay intact.
- **Copy workspace path**: hover a workspace row and a native-styled button appears left of the ⋯ / + pair.
- **Instant absolute path copy**: one click copies the workspace absolute path — measured at 42 ms.
- **Double-click rename**: double-click a session row to open the official rename dialog (native menu path).
- **Session detail panel**: context pressure, token usage, execution stats and last activity per session.
- **Zero-residue uninstall**: every sidebar injection is append-only; uninstall restores the stock UI byte for byte.

## 30-second tour

1. Install with either command above; after a DSH restart a manager icon appears next to "Workspaces".
2. Click the icon — the overlay lists active and archived sessions grouped by workspace.
3. Select a few sessions and hit Archive; they move into the archive bucket.
4. Select inside the archive bucket and hit Restore to bring them back.
5. Select cold sessions and hit Delete for a confirmed hard delete (core patch required, see below).
6. Hover any workspace row; a copy-path button appears left of the ⋯ / + pair.
7. Click it — the icon flips to a green ✓ and a toast shows the absolute path.
8. A hung session? Open it and hit ⟳ in the header: force-stop with auto-resume.
9. Double-click any session row to rename it via the official dialog.
10. Re-open the overlay from the sidebar footer anytime to double-check.

## Daily usage

- Start each day in the manager overlay: scan yesterday's running sessions per workspace.
- Archive exploratory sessions when done; keep the main list to active work only.
- Check context pressure and token usage in the detail panel before archiving.
- Double-click-rename test sessions to label their purpose — no more "New session (3)".
- Hover a workspace row to copy its absolute path straight into your terminal.
- Frontend loop broke the AgentLoop? ⟳ force-stop with auto-resume keeps queued messages flowing.
- Use ⏻ leave-offline for long batch jobs: walk away, restore manually later.
- Weekly cleanup: sort the archive bucket by last activity and hard-delete month-old failures.
- Suspicious session state? The detail panel shows execution stats and last activity.
- After a DSH upgrade, run core-patch --check to confirm hard-delete is alive.

## Input / output examples

- Input `GET /dsh-manage-sessions/workspaces` → output `{"ok":true,"workspaces":[{"id":"w1","title":"sample-app","path":"/srv/sample-app"}]}`
- Input `POST /dsh-manage-sessions/force-stop {"id":"...","mode":"resume"}` → output `{"ok":true,"stoppedVia":"cancel","resumed":true,"elapsedMs":8065}`
- Input `node scripts/core-patch.mjs --check` → output a per-file applied/invalid list; exit 0 means healthy.
- Input `npm test` → output `# tests 99 / # pass 99 / # fail 0`.
- Input `dsh plugin add github:hoyyang/dsh-manage-sessions` → output install + inject logs.
- Input `npm view dsh-manage-sessions version` → output `0.7.0`.
- Hover a workspace row → a third same-style button appears left of ⋯ / +.
- Click the copy button → a ✓ flash (1.2 s) plus a toast with the full path.

## Use cases

- **Stuck-agent rescue**: a model call hangs for 57 minutes with stop doing nothing → ⟳ force-stop with auto-resume, back to work in 8 s.
- **Long-session hygiene**: a week of exploratory sessions floods the sidebar → bulk archive, keep only active work.
- **Accidental-delete guard**: hard delete forces confirmation; running or reserved batches are rejected with a full blocker list.
- **Multi-repo switching**: five workspaces open — hover for the absolute path, paste into a terminal or CI script with zero friction.
- **Context checkup**: confirm context pressure and token usage in the detail panel before committing a large change.
- **Session handoff**: rename "New session (3)" into something meaningful via the official dialog.
- **Batch and leave**: put long jobs offline with ⏻ and restore them manually when back.
- **Cold cleanup**: sort the archive bucket by last activity and hard-delete month-old failed experiments.
- **Post-upgrade self-check**: one core-patch --check confirms hard-delete survived a DSH upgrade.
- **Purist restore**: uninstall and the sidebar and header return to the stock UI exactly.

## Outputs

- Clicking copy flips the button icon to a green ✓ (1.2 s) and shows a bottom toast with the full path.
- A successful force-stop returns a full trace (e.g. `["cancel"]` or `["cancel","phase-reset"]`) plus `elapsedMs`.
- Archive returns `archivedIds` with per-session timestamps; restore returns `unarchivedIds`.
- `core-patch --check` prints a per-file applied/invalid list; the exit code is CI-ready.
- First start auto-migrates the legacy state directory wholesale — journal and archive times survive.
- The GitHub Release ships a prebuilt tgz with a sha256 checksum for offline installs.
- The npm package `dsh-manage-sessions` is version-synced with this repository.
- Uninstalling removes every injected button, observer and toast — the official DOM is restored exactly.

## Reliability

- **99/99 unit tests** (node:test): transport gates, force-stop escalation, copy bridge, entry bridge, state migration.
- **Dual-tsconfig typecheck**: host and client both green.
- **Cold-start static checks**: junctions, bundle manifests, route collisions, client registration ids ([A]-[F]) all green.
- **Loopback-only transport**: every route accepts 127.0.0.0/8 only; cross-origin writes get 403.
- **Fail-closed delete**: with capabilities missing, hard delete refuses and says so — never a silent fallback.
- **Fail-loud feedback**: no-match directories, clipboard failures and route faults all name themselves in toasts.
- **Pinned host support**: only DSH 0.1.5-rc.1; unknown versions refuse to enable instead of guessing APIs.
- **prefers-reduced-motion**: every animation honors the system reduce setting.
- **Accessibility**: injected buttons carry aria-label and focus-visible; the toast is aria-live.
- **Clean uninstall**: the disposer removes all injected nodes, observers and listeners; reinstall is idempotent.

## Advanced

**Hard delete** relies on a set of core compatibility patches (the installer prompts automatically). After a DSH upgrade or reinstall, re-apply:

```bash
node scripts/core-patch.mjs --check
node scripts/core-patch.mjs --apply
node scripts/core-patch.mjs --revert
```

Without the patch, hard delete fails closed (the UI says so) and everything else keeps working.

## How it works

The manager overlay reads the official useSessions / useWorkspaces runtime hooks (same canonical source as the home page). Copy-path goes through the plugin's own loopback-only HTTP route /dsh-manage-sessions/workspaces (registry direct read, no session scans). Force-stop walks the agents contract (cancel → phase reset) in stages. Sidebar augmentation mounts via official slots plus append-only bridges — nothing official is mutated, and uninstalling restores the stock UI.

## FAQ

**Hard delete is greyed out?** Run node scripts/core-patch.mjs --check && --apply and restart DSH.
**Does force-stop lose messages?** Auto-resume keeps queued messages; leave-offline drops the in-memory queue (session logs are kept).
**No copy button?** The ungrouped bucket has no path and gets no button; if a real workspace row still lacks it after a refresh, please file an issue.

## Build from source

```bash
npm ci
npm run build && npm test
```

## License

[MIT](LICENSE)
