# Security and privacy

MTrace exports potentially sensitive session evidence. A public code repository does not make exported evidence safe to publish.

- Before sharing an export, review conversation text, tool inputs/results, local paths, URLs and any embedded credentials. The privacy projector reduces known sensitive fields and media/reasoning content, but cannot guarantee that arbitrary user-authored text is secret-free.
- Full and Prompt/runtime modes use OpenClaw's diagnostic runtime capture. That upstream source can omit or truncate content; a partial warning is not an error to bypass.
- One-time download links are session/generation-bound, expire, and should not be copied into tickets or public chat. A reset invalidates old results.
- Runtime CLI bundles are archived locally under `~/Archive-Pending-Delete/`. Restrict local access and review the retention footprint before deploying on shared hosts.
- Keep OpenClaw and the plugin's compatibility versions aligned. Do not disable install policy or Gateway safeguards to force an upgrade.

For a vulnerability, use GitHub's **Report a vulnerability** private advisory flow if enabled for this repository. Otherwise contact the maintainer privately through GitHub before posting details. Do not attach real transcripts, keys or private host logs to a public issue. Use a minimal synthetic reproducer instead.
