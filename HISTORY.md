# Development history and provenance

This Git repository was assembled **after** the original local development. Commits labeled `history: reconstruct` reflect source snapshots of 0.1.0, 0.1.1, 0.1.2, 0.2.0 and 0.2.1. They are **not** the original contemporaneous commits; their Git timestamps are the reconstruction date. No private transcripts, trajectories, host validation logs, local configuration, old packed artifacts or machine-specific test harnesses were imported.

The first three snapshots established the panel, branch ownership checks and one-time download. Long-session evidence later exposed a critical 0.1.2 limitation: a diagnostic projection could be cut to 64 nodes and select the wrong current conversation after reset. Version 0.2.0 changed the source of authority to intact retained transcript structure, validated boundary and ownership, and made runtime coverage limitations explicit. Version 0.2.1 improved expected empty/no-direct-user guidance without changing successful exports.

The locally observed 0.2.1 test suite passed 81/81 synthetic and SDK/UI tests against OpenClaw 2026.9.6. Subsequent native use confirmed the active 0.2.1 panel and downloads on the development host. No independent security review, multi-host compatibility certification, or guarantee of complete upstream diagnostic capture is claimed. For release-specific details see [CHANGELOG.md](CHANGELOG.md).

**Support policy:** v0.2.1 is the only release candidate. Historical 0.1.x source exists for review; in particular 0.1.2 must not be used as a trustworthy content-export fallback. Compatibility remains pinned to OpenClaw 2026.9.6 until another version is tested.
