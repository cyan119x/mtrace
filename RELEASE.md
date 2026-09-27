# v0.2.1 release notes

MTrace 0.2.1 is the first proposed public release of this independent OpenClaw Feature Plugin. Compatibility is pinned to OpenClaw 2026.9.6.

It offers reset-aware Transcript, Full evidence, Prompt + tool/runtime and all-retained-History modes in the native Control UI. Results contain readable Markdown, a coverage/reset manifest and exact-count JSONL. A one-time, generation-bound download prevents stale results after a session switch or reset. The 0.2.1 change makes empty/no-direct-user states actionable instead of displaying a generic error.

**Important limitations:** diagnostic runtime may be incomplete; ordinary tool/conversation content can still reveal sensitive information; archived CLI workspaces consume disk; and 0.1.2's long-session content export is known to be unreliable. Do not publish raw exports without review. No compatibility claim is made for other OpenClaw versions.

Verification before publication: synthetic local suite 81/81 passed on the pinned host; build/validate/pack and artifact integrity must be repeated on this public tree. The earlier private native acceptance is development-host evidence, not independent multi-host review.
