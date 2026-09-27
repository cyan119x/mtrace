# MTrace

Reset-aware session evidence for OpenClaw's Control UI. MTrace is an independent Feature Plugin, not an OpenClaw core patch. **Current supported version: 0.2.1; compatibility pinned to OpenClaw 2026.9.6.** Other versions are not yet verified.

MTrace helps answer: "What happened in this conversation since the latest reset?" It can also export all retained sidebar-session history. Native OpenClaw already offers a readable current-chat Markdown export and a whole-session trajectory bundle; MTrace is useful when you need **structured, reset-scoped transcript plus available runtime evidence**, a clear coverage declaration, and a guarded one-time download.

## Export modes

- **Transcript:** readable conversation plus JSONL for retained entries on the active branch, starting with the first direct user message after the latest reset. No trajectory CLI invocation.
- **Full evidence:** the same scoped transcript plus available diagnostic runtime events owned by the selected runs.
- **Prompt + tool/runtime:** selected user/tool records and available runtime, without unrelated assistant prose in a hidden file.
- **Full sidebar-session history:** all retained canonical entries across reset epochs and branches, plus retained diagnostic runtime. This can be large.

The Markdown file contains a readable section, a manifest with exact event counts and reset boundary, and structured JSONL. "Full" means the selected mode's retained source records, **not** a guarantee of every raw prompt, tool byte, or internal model state. Runtime capture upstream can omit or truncate data; MTrace marks that coverage as partial and does not invent missing content. If the latest reset has no direct user message yet, current modes report an actionable needs-input state and do not produce an artifact.

## Install

1. Use the **v0.2.1 release archive** from this repository, or build it from the matching source. Inspect the archive and its checksum before installing. Do not use the old 0.1.2 build as a fallback for content exports.
2. On a compatible OpenClaw 2026.9.6 host, use the official plugin installer, for example `openclaw plugins install ./mtrace-v0.2.1.tgz`. Follow the host's trust and capability prompts. Enable `mtrace` through the official plugin controls if needed; do not bypass install policy.
3. Check `openclaw plugins inspect mtrace --runtime --json` for version, enabled, activated and loaded status. A saved package may not be live until the Gateway has safely replaced its generation. Coordinate any necessary Gateway restart after active work is idle; refreshing the Control UI may be needed so the UI and backend have the same revision.
4. Open a session in the Control UI and choose **MTrace**. Select a mode, inspect the reported scope/coverage, then download. One-time links expire and cannot be reused.

No account, external API key, model call, extra capture service, OpenClaw core edit, or changed retention setting is required for an export. This repository is public source code; **never upload actual session evidence to it**.

## Privacy and operational limits

- Credential-shaped fields, inline media bytes and private reasoning/replay material are projected out. Ordinary conversation and tool payloads can still contain personal information, local paths or other sensitive content. **Review every file before sharing it.**
- Session identity and lifecycle are checked during export and download. A reset or session switch invalidates stale results. The download token is random, stored only as a hash, and consumed by a successful GET; HEAD does not consume it.
- Delivery bodies are held in bounded process memory: up to four artifacts, 128 MiB total, 64 MiB per file, a 30-minute TTL, and at most two concurrent exports (one per session). Exceeding limits fails visibly rather than silently truncating.
- For runtime modes, the official trajectory CLI's temporary workspace is **moved to `~/Archive-Pending-Delete/` with a manifest rather than permanently deleted**. This conservative retention is intentional and can grow disk usage. It may not suit every host's retention policy; review before deployment and let the owner clean it manually. MTrace does not put its one-time download body there.

## Develop and test

Source lives in `src/` (Control UI) and `dist/*.js` (backend modules); the generated hashed UI bundle is not committed. The backend uses documented public plugin SDK imports at runtime. Version-pinned differential tests refer to an internal OpenClaw module **only in the test suite**, not in production code.

Install development dependencies with `npm ci`. Point tests to an installed **OpenClaw 2026.9.6 package directory**:

```sh
OPENCLAW_PACKAGE_ROOT=/path/to/openclaw npm run test:local
npm run build
npm run validate
openclaw plugins pack --out ./mtrace-v0.2.1.tgz --json
```

These commands require a compatible OpenClaw CLI. Never run a live-session validation against someone else's session. Local tests use synthetic fixture content. See [CHANGELOG.md](CHANGELOG.md), [HISTORY.md](HISTORY.md), [SECURITY.md](SECURITY.md), and [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

## License

MIT for MTrace-authored code; adapted OpenClaw code retains its MIT notice in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). See [LICENSE](LICENSE).
