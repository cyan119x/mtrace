# Changelog

Changes are listed by source snapshot. Historical commits were reconstructed from local versioned source trees, not recovered from an original Git history. Only v0.2.1 is proposed as the public GitHub release.

## 0.2.1 (2026-09-26)

- Return typed, actionable "no direct user since reset" and empty-conversation outcomes instead of a generic plugin-action failure. No file or download link is produced in these states.
- Preserve the 0.2.0 scope selection, privacy projection, runtime adapter, one-time delivery and successful output format. Backend and Control UI must be activated together.
- Local suite: 81 tests passed; native activation and a real post-reset export were subsequently checked on the development host. This is **not** a claim of universal compatibility.

## 0.2.0 (2026-09-26)

- Replace the lossy 64-node diagnostic branch preview as reset-scope authority with retained public transcript events and a version-pinned navigation adapter.
- Rebuild current Transcript, Full evidence, Prompt + tool/runtime and full History modes with manifest, readable Markdown and exact-count JSONL. Distinguish retained transcript completeness from partial diagnostic runtime capture.
- Add fail-closed structural/ownership checks, privacy projection, session-generation checks, bounded in-memory one-time delivery and UI stale-result protection.
- Use the official trajectory CLI only to read available runtime events, not to define the active branch. This corrects 0.1.2's wrong-content exports on long/reset sessions.

## 0.1.2 (2026-09-25, historical; **do not use for content exports**)

- Fix browser download authentication with plugin-authenticated route and hashed 256-bit one-time capability; HEAD does not consume, GET consumes once.
- Did **not** repair the diagnostic branch projection used for export scope; later testing showed wrong-content exports. Kept in history for transparency, not offered as a supported release.

## 0.1.1 (2026-09-25, historical)

- Accept legitimate shared run IDs when the selected branch contains a direct user anchor; continue excluding off-branch transcript records.
- Avoid needless panel identity refresh/layout shift on ordinary host updates.

## 0.1.0 (2026-09-25, historical)

- Initial native Control UI Feature Plugin panel, export mode contract, runtime integration and early local tests.
