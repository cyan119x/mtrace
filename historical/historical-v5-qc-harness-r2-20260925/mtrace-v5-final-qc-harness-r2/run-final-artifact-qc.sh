#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/path/to/historical-sources/openclaw-mtrace-v5-staging-2026.9.6}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/mtrace-v5-final-qc-multireset-test.patch"
TARGET="src/gateway/mtrace-http.test.ts"
EXPECTED_SHA="c2bd76c1c29e7ce12d11e93c4bdba0d9f0dddfdb882b0a90411d327116b74447"
LOG="${TMPDIR:-/tmp}/mtrace-v5-final-artifact-qc-$(date +%Y%m%dT%H%M%S).log"
BACKUP="${TMPDIR:-/tmp}/mtrace-http.test.ts.qc-backup.$$"

fail() {
  echo "ERROR: $*" | tee -a "$LOG" >&2
  echo "QC log: $LOG" >&2
  exit 1
}

run_cmd() {
  echo | tee -a "$LOG"
  printf '>>> ' | tee -a "$LOG"
  printf '%q ' "$@" | tee -a "$LOG"
  echo | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
}

[ -d "$ROOT" ] || fail "staging worktree not found: $ROOT"
[ -f "$PATCH" ] || fail "QC patch not found: $PATCH"
cd "$ROOT"
[ -f "$TARGET" ] || fail "missing expected test file: $TARGET"

actual_sha="$(sha256sum "$TARGET" | awk '{print $1}')"
[ "$actual_sha" = "$EXPECTED_SHA" ] || fail "unexpected $TARGET sha256: $actual_sha; expected $EXPECTED_SHA. Stop; do not adapt automatically."

cp -p "$TARGET" "$BACKUP"
restore() {
  if [ -f "$BACKUP" ]; then
    cp -p "$BACKUP" "$TARGET"
    rm -f "$BACKUP"
  fi
}
trap restore EXIT

run_cmd git apply --check "$PATCH"
run_cmd git apply "$PATCH"

# Format only the temporary test-harness change. Product source is untouched.
run_cmd corepack pnpm exec oxfmt "$TARGET"
run_cmd corepack pnpm exec oxfmt --check "$TARGET"

# Run exactly one integration-QC test. It creates one synthetic persistent
# session A -> reset -> B -> reset -> C, passes it through the real trajectory
# exporter plus the real Mtrace HTTP/Markdown/download path, and verifies all
# four artifact modes.
run_cmd corepack pnpm exec vitest run "$TARGET" \
  --maxWorkers=1 \
  -t "creates all four Mtrace artifacts from one real A-reset-B-reset-C trajectory"

run_cmd git diff --check -- "$TARGET"

# Restore the original test file so the validated product candidate is unchanged.
restore
trap - EXIT
restored_sha="$(sha256sum "$TARGET" | awk '{print $1}')"
[ "$restored_sha" = "$EXPECTED_SHA" ] || fail "failed to restore original staging test file"

echo | tee -a "$LOG"
echo "MTRACE_FINAL_ARTIFACT_QC=PASS" | tee -a "$LOG"
echo "The validation-only test harness was removed; product candidate source is unchanged." | tee -a "$LOG"
echo "No production deploy/restart is performed by this script." | tee -a "$LOG"
echo "QC log: $LOG" | tee -a "$LOG"
echo "STOP HERE." | tee -a "$LOG"
