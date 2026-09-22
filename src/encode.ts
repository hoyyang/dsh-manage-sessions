/**
 * Path-safety helpers shared by staging and recovery.
 *
 * The JSONL backend owns each session exactly one directory
 * (`<root>/<projectKey>/<encodeSegment(id)>/`) holding a JSONL artifact.
 * 0.1.5 renamed the artifact from `session.jsonl[.zstd]` to a versioned
 * generation name `session.vN.jsonl[.zstd]` (migration leaves both on disk).
 * This plugin only ever renames/deletes that exact directory, and only after
 * verifying both:
 *  - the directory basename equals the backend's `encodeSegment(id)`, and
 *  - the located artifact basename matches the JSONL generation convention.
 *
 * `encodeSegment` below is a faithful replication of the backend's injective
 * path-segment encoding (safe code units literal, everything else `~XXXX`).
 * It is used for verification only — the backend remains the authority for
 * building paths via `locate`.
 */

export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

export type StagingPathCheck =
  | { ok: true; dir: string }
  | { ok: false; reason: string }

/**
 * Validate that `artifactPath` is a session-owned JSONL artifact we may stage:
 * parent basename must decode to the exact session id and the artifact name
 * must be `session[.v<N>].jsonl[.zstd]` (0.1.5 generation naming, legacy
 * unversioned name still accepted for migrated artifacts). Pure — no
 * filesystem access.
 */
const JSONL_ARTIFACT_PATTERN = /^session(?:.v\d+)?\.jsonl(?:\.zstd)?$/
export function validateSessionArtifactPath(artifactPath: string, id: string): StagingPathCheck {
  if (!artifactPath || artifactPath.length === 0) return { ok: false, reason: 'empty artifact path' }
  const sep = artifactPath.includes('\\') && !artifactPath.includes('/') ? '\\' : '/'
  const firstSep = artifactPath.lastIndexOf(sep)
  if (firstSep <= 0) return { ok: false, reason: 'artifact path has no parent directory' }
  const filename = artifactPath.slice(firstSep + 1)
  const dir = artifactPath.slice(0, firstSep)
  const secondSep = dir.lastIndexOf(sep)
  if (secondSep < 0) return { ok: false, reason: 'artifact parent has no parent directory' }
  const dirname = dir.slice(secondSep + 1)
  if (!JSONL_ARTIFACT_PATTERN.test(filename)) {
    return { ok: false, reason: `artifact basename ${JSON.stringify(filename)} is not a supported JSONL session artifact` }
  }
  let expected: string
  try {
    expected = encodeSegment(id)
  } catch (error) {
    return { ok: false, reason: `unencodable session id: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (dirname !== expected) {
    return {
      ok: false,
      reason: `parent directory ${JSON.stringify(dirname)} is not the backend-encoded session dir (${JSON.stringify(expected)})`,
    }
  }
  return { ok: true, dir }
}
