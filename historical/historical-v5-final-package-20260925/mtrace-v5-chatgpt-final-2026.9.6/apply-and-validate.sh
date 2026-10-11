#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/path/to/historical-sources/openclaw-mtrace-v5-staging-2026.9.6}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/mtrace-v5-chatgpt-final-2026.9.6.patch"
BASE_COMMIT="eb377ac59e6c9fd6c7705028034812becf00271b"
LOG="${TMPDIR:-/tmp}/mtrace-v5-chatgpt-validate-$(date +%Y%m%dT%H%M%S).log"

FILES=(
  src/trajectory/current-conversation.ts
  src/trajectory/current-conversation.test.ts
  src/trajectory/current-conversation-export.test.ts
  src/trajectory/export.ts
  src/trajectory/types.ts
  src/gateway/mtrace-http.ts
  src/gateway/mtrace-http.test.ts
)
PRE_HASHES=(
  b77f715a9fa09559820e0e0f3c978fbdc4728f3d8a7c3509cbdac619227a6ea3
  be0bc21e8e31e02b7356c4eadbbf3ad5dc396b502f538dc7d8122d0e9efaf5b1
  7c547442aa758908f2699d7891a518694e026b9cf3d87b00bcfca0c96f8267d8
  cdbe618c685f7eb159c028f8c039fa23d9744588324709a2810bc1da92ef4cf7
  1ac3e0ca87706d129084a0f8161e3cff4dc2de00eecd58baf01a8fda05c922ab
  7a564cf570136ad02192511b7bc3248e322cbfd07a033e0720c320e7ce8711d0
  c513b2b7a0462b86b009571f66975e45c23e0e923f9ced7b22da19d7d59f8925
)
POST_HASHES=(
  51d376bd1404bbff79adea7ed4ab1721b69295b76e4961bf99d928ddfdfb5a25
  6d85f997d333a2a83178c94a249a997b888778f3218f934ca36ba8dad30b69c9
  3bcacab29ba23a2a5e8b826ab472dbc864ef13aa4edf14e73d4056ea3aefa266
  cee29022a21635b8c16b54f1b0fc5206cf3311fccfdc479feea5b08c556cc3cb
  b702ca9d5bfdc7a7220e1daa87cffc3d758b6a8d7ed04dfe46ce25f2ba8c3ecf
  f818fbe3e5dea258afd47f7a000d410f56a5a21ea7f3b8a78e4dd4258eb24df5
  c2bd76c1c29e7ce12d11e93c4bdba0d9f0dddfdb882b0a90411d327116b74447
)

fail() {
  echo "ERROR: $*" | tee -a "$LOG" >&2
  echo "Validation log: $LOG" >&2
  exit 1
}

# Simpler logging wrapper that preserves command status.
run_cmd() {
  echo | tee -a "$LOG"
  printf '>>> ' | tee -a "$LOG"
  printf '%q ' "$@" | tee -a "$LOG"
  echo | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
}

trap 'rc=$?; echo "FAILED (exit $rc). Do not debug further automatically." | tee -a "$LOG" >&2; echo "Validation log: $LOG" >&2; exit $rc' ERR

[ -d "$ROOT" ] || fail "staging worktree not found: $ROOT"
[ -f "$PATCH" ] || fail "patch not found: $PATCH"
cd "$ROOT"

actual_base="$(git rev-parse HEAD)"
[ "$actual_base" = "$BASE_COMMIT" ] || fail "unexpected base commit: $actual_base"

pre=0
post=0
for i in "${!FILES[@]}"; do
  f="${FILES[$i]}"
  [ -f "$f" ] || fail "missing expected file: $f"
  h="$(sha256sum "$f" | awk '{print $1}')"
  if [ "$h" = "${PRE_HASHES[$i]}" ]; then
    pre=$((pre+1))
  elif [ "$h" = "${POST_HASHES[$i]}" ]; then
    post=$((post+1))
  else
    fail "unexpected content in $f (sha256 $h); refusing to patch a drifted worktree"
  fi
done

if [ "$post" -eq "${#FILES[@]}" ]; then
  echo "ChatGPT patch is already applied; continuing to validation." | tee -a "$LOG"
elif [ "$pre" -eq "${#FILES[@]}" ]; then
  run_cmd git apply --check "$PATCH"
  run_cmd git apply "$PATCH"
else
  fail "mixed pre/post patch state; refusing partial application"
fi

for i in "${!FILES[@]}"; do
  f="${FILES[$i]}"
  h="$(sha256sum "$f" | awk '{print $1}')"
  [ "$h" = "${POST_HASHES[$i]}" ] || fail "post-patch hash mismatch for $f"
done

# Deterministic focused validation only. No browser exploration, no live Gateway,
# no model call, no production deployment.
run_cmd corepack pnpm exec vitest run \
  src/trajectory/current-conversation.test.ts \
  src/trajectory/current-conversation-export.test.ts \
  src/gateway/mtrace-http.test.ts \
  ui/src/components/mtrace/mtrace-panel.test.ts \
  --maxWorkers=1

run_cmd corepack pnpm tsgo:ui
run_cmd corepack pnpm exec oxfmt --check \
  src/trajectory/current-conversation.ts \
  src/trajectory/current-conversation.test.ts \
  src/trajectory/current-conversation-export.test.ts \
  src/trajectory/export.ts \
  src/trajectory/types.ts \
  src/gateway/mtrace-http.ts \
  src/gateway/mtrace-http.test.ts
run_cmd git diff --check
run_cmd corepack pnpm build

echo | tee -a "$LOG"
echo "MTRACE_CHATGPT_VALIDATION=PASS" | tee -a "$LOG"
echo "Production was not deployed or restarted by this script." | tee -a "$LOG"
echo "Validation log: $LOG" | tee -a "$LOG"
echo "STOP HERE. Do not activate Mtrace until the operator explicitly approves production deployment." | tee -a "$LOG"
