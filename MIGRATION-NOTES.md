# Migration from 0.1.2 to 0.2.0

0.1.2 incorrectly used a 64-node/64-key diagnostic session-branch projection as scope authority. 0.2.0 reads intact transcript events through public SDK, uses a version-pinned local navigation adapter, validates the latest reset, scopes before per-record privacy projection, and builds own transcript evidence. No core changes. Runtime uses official sessions export-trajectory only as available diagnostic evidence, with explicit partial coverage.

Output format is mtrace/feature-plugin-v2: readable Markdown plus manifest and exact-count JSONL; the old BEGIN FILE pseudo-bundle is replaced. Consumers must use the new manifest/mode/coverage contract. Counts no longer describe a hidden full superset. Full history is rebuilt from all retained canonical entries, not the diagnostic branch preview.

Artifacts moved from plaintext temporary files to bounded in-memory one-time bodies. Transient CLI diagnostic workspaces are now reversibly archived according to owner policy rather than permanently removed; this has disk-retention implications noted in README. No new runtime capture or retention setting is changed.

UI now places actions compactly, displays scope/time/count/coverage, handles stale generations and async responses, and verifies HTTP delivery before browser handoff. Browser-native integration still needs acceptance after approved activation.
