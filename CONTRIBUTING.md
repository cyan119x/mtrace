# Contributing

Issues and pull requests are welcome for MTrace code, documentation and synthetic tests. Open an issue before broad architecture changes. The supported baseline is OpenClaw 2026.9.6; specify the exact version used in a bug report.

1. Fork and branch from `main`. Never commit session transcripts, trajectory bundles, secrets, local config, host logs, private URLs or personal paths.
2. Run `npm ci`, point `OPENCLAW_PACKAGE_ROOT` at an installed OpenClaw 2026.9.6 package directory, and run `npm run test:local`, `npm run build` and `npm run validate`.
3. Explain the reset boundary, ownership, privacy and truncation behavior affected by a change. Add synthetic regression tests. Do not make a partial source appear complete.
4. Keep [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) when adapting upstream code. This repo is MIT licensed; contributions are submitted under that license.

Avoid real live-session fixtures. If a report depends on a host-specific failure, sanitize its metadata and reproduce it with synthetic records before publishing.
