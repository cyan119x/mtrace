# Project status and continuation

## Goal and architecture
MTrace provides reset-aware session evidence export inside the native OpenClaw Control UI. The public plugin targets OpenClaw 2026.9.6. Keep it independent of the earlier core-patched implementation. Transcript structure, not a diagnostic preview, defines branch/reset scope. Runtime evidence has explicit partial-coverage semantics and must not be presented as complete merely because it exists.

## Recorded decisions and corrections
1. The 0.1.x line introduced panel integration, shared-run ownership and one-time authenticated download. Version 0.1.2 still selected incorrect content when a lossy diagnostic projection hid the latest reset. Do not treat successful downloads as correct evidence or use 0.1.2 as a fallback.
2. Version 0.2.0 moved scope selection to intact retained transcript structure, added fail-closed boundary/ownership checks, explicit coverage, bounded in-memory delivery and lifecycle protection.
3. Version 0.2.1 added typed empty/no-direct-user guidance without changing successful output generation. Backend and UI compatibility must be considered together.
4. The existing Git history is a later reconstruction from versioned source, not the original development chronology. New historical references do not change that disclosure.
5. The current source checkout and installed runtime are distinct. Source archival or migration does not authorize runtime changes.

## Continuation checklist
- [x] Keep current 0.2.1 source and existing public graph; do not overwrite newer remote work.
- [x] Preserve meaningful historical source differences and exact duplicate mapping.
- [x] Retain historical limitations, source provenance and third-party notices.
- [x] Keep private evidence out of the public handoff.
- [ ] Independently review the exact outgoing commit and complete public retrieval verification.
- [ ] Test compatibility on any new OpenClaw version before changing the version pin.
- [ ] macOS, native panel lifecycle and Codex/Claude auto-loading need separately authorized verification if required.

## Evidence confidence
The functional milestones above are supported by existing public HISTORY.md, CHANGELOG.md and source comparisons, plus selective project-level summaries from historical revision, implementation and handoff documents. Historical local test/native claims remain dated records, not tests rerun for this handoff. This preparation uses syntax checks and a finite pure synthetic test subset only. No full build, SDK integration, live Gateway/session, packaging, download, native UI or macOS acceptance is claimed.

Private notes informed the architectural correction and source/runtime separation only. Personal identities, operational event details, host paths, session IDs and historical tool payloads are intentionally absent. See historical/SOURCE_MAP.json for per-file provenance and excluded document originals.
