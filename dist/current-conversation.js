function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function textOf(message) {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((p) => isRecord(p) && p.type === "text" && typeof p.text === "string").map((p) => p.text).join(" ");
}
function optionalString(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function isDirectUser(entry) {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return false;
  const provenance = isRecord(entry.message.provenance) ? entry.message.provenance : undefined;
  if (provenance?.kind === "inter_session") return false;
  return !/^\/reset(?:\s|$)/iu.test(textOf(entry.message).trim());
}
function addRunIdsFromMessage(message, target) {
  if (!isRecord(message)) return;
  const meta = isRecord(message.__openclaw) ? message.__openclaw : {};
  const direct = optionalString(meta.runId); if (direct) target.add(direct);
  const steer = optionalString(meta.steerTargetRunId); if (steer) target.add(steer);
  const key = optionalString(message.idempotencyKey);
  if (!key) return;
  const canonical = /^(.*):user(?::.*)?$/u.exec(key);
  if (canonical?.[1]?.trim()) target.add(canonical[1].trim());
  const prefix = "hook-block:before_agent_run:user:";
  if (key.startsWith(prefix) && key.slice(prefix.length).trim()) target.add(key.slice(prefix.length).trim());
  target.add(key);
}
function collectRunIds(entries) {
  const out = new Set();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.type === "message") addRunIdsFromMessage(entry.message, out);
    if (entry.type === "compaction") {
      const meta = isRecord(entry.__openclaw) ? entry.__openclaw : {};
      const runId = optionalString(meta.runId); if (runId) out.add(runId);
    }
  }
  return out;
}
function collectUserAnchoredRunIds(entries) {
  const out = new Set();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") continue;
    addRunIdsFromMessage(entry.message, out);
  }
  return out;
}
function parseTime(value, label) {
  const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error(`${label} has an invalid timestamp`); return n;
}
export function selectCurrentConversation({ branchEntries, allEntries, runtimeEvents }) {
  const resetIndex = branchEntries.findLastIndex((e) => isRecord(e) && e.type === "reset");
  let selectedEntries; let resetBoundaryAt; let resetBoundaryEntryId; let conversationStartedAt;
  if (resetIndex < 0) {
    selectedEntries = [...branchEntries];
    conversationStartedAt = optionalString(selectedEntries[0]?.timestamp);
  } else {
    const reset = branchEntries[resetIndex];
    const firstUserIndex = branchEntries.findIndex((entry, index) => index > resetIndex && isDirectUser(entry));
    if (firstUserIndex < 0) throw new Error("Current conversation has no direct user message after the latest reset");
    const firstUser = branchEntries[firstUserIndex];
    parseTime(firstUser.timestamp, "Current conversation start");
    selectedEntries = branchEntries.slice(firstUserIndex);
    resetBoundaryAt = optionalString(reset.timestamp);
    resetBoundaryEntryId = optionalString(reset.id);
    conversationStartedAt = optionalString(firstUser.timestamp);
  }

  const runtimeRunIds = new Set(runtimeEvents.map((e) => optionalString(e.runId)).filter(Boolean));
  const selectedCandidates = collectRunIds(selectedEntries);
  const selectedRunIds = new Set([...selectedCandidates].filter((id) => runtimeRunIds.has(id)));
  const selectedUserAnchors = collectUserAnchoredRunIds(selectedEntries);
  const selectedIds = new Set(selectedEntries.map((e) => optionalString(e.id)).filter(Boolean));
  const activeIds = new Set(branchEntries.map((e) => optionalString(e.id)).filter(Boolean));
  const knownNonSelected = collectRunIds(allEntries.filter((e) => !selectedIds.has(optionalString(e.id))));
  const offBranch = collectRunIds(allEntries.filter((e) => !activeIds.has(optionalString(e.id))));

  // A single OpenClaw run may legitimately leave more than one transcript row,
  // including an abandoned/off-branch row. Runtime evidence is run-scoped, not
  // transcript-row-scoped. Treat a shared run as safe when the selected branch
  // contains a user row that directly anchors that run. Off-branch transcript
  // rows are still excluded later by entry id. If a shared run is present only
  // through assistant/compaction ownership on the selected branch, keep failing
  // closed because runtime ownership cannot be established safely.
  const sharedRunIds = new Set();
  for (const id of selectedRunIds) {
    if (!offBranch.has(id)) continue;
    if (!selectedUserAnchors.has(id)) {
      throw new Error(`Cannot safely scope current conversation runtime events because run ${id} is shared with an off-branch transcript entry and has no selected user anchor`);
    }
    sharedRunIds.add(id);
  }

  const startMs = conversationStartedAt ? parseTime(conversationStartedAt, "Current conversation start") : 0;
  const selectedRuntime = []; const unowned = []; const unknown = [];
  for (const event of runtimeEvents) {
    const runId = optionalString(event.runId);
    if (runId && selectedRunIds.has(runId)) { selectedRuntime.push(event); continue; }
    if (parseTime(event.ts, "Runtime event") < startMs) continue;
    if (!runId) unowned.push(event); else if (!knownNonSelected.has(runId)) unknown.push(event);
  }
  if (unowned.length) throw new Error(`Cannot safely scope current conversation runtime events: ${unowned.length} post-boundary runtime event(s) have no runId`);
  if (unknown.length) {
    const ids = new Set(unknown.map((e) => optionalString(e.runId)).filter(Boolean));
    throw new Error(`Cannot safely scope current conversation runtime events: ${unknown.length} post-boundary runtime event(s) belong to ${ids.size} run(s) with no transcript ownership`);
  }
  if (!selectedRuntime.length && !selectedRunIds.size && runtimeEvents.some((e) => parseTime(e.ts, "Runtime event") >= startMs)) {
    throw new Error("Cannot safely scope current conversation runtime events because the active branch exposes no run ownership");
  }
  return {
    selectedEntries,
    selectedRuntime,
    selectedRunIds: [...selectedRunIds].sort(),
    sharedRunIds: [...sharedRunIds].sort(),
    resetBoundaryAt,
    resetBoundaryEntryId,
    conversationStartedAt
  };
}
