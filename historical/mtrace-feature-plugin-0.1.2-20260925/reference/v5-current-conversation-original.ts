import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import { readMessageIdempotencyKey } from "../config/sessions/transcript-message-identity.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import type { TrajectoryEvent } from "./types.js";

export type CurrentConversationSelection = {
  entries: SessionEntry[];
  runtimeEvents: TrajectoryEvent[];
  runIds: string[];
  resetBoundaryAt?: string;
  resetBoundaryEntryId?: string;
  conversationStartedAt?: string;
};

function messageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join(" ");
}

function isDirectUserMessage(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message.role !== "user") {
    return false;
  }
  const message = entry.message as unknown as Record<string, unknown>;
  const provenance = message.provenance;
  if (
    provenance &&
    typeof provenance === "object" &&
    (provenance as Record<string, unknown>).kind === "inter_session"
  ) {
    return false;
  }
  return !/^\/reset(?:\s|$)/i.test(messageText(message).trim());
}

function collectIdempotencyRunIdCandidates(message: unknown, target: Set<string>): void {
  const key = readMessageIdempotencyKey(message);
  if (!key) {
    return;
  }

  // Canonical admitted user turns use `${runId}:user`; late-media carriers
  // extend that with another suffix. Run ids themselves may contain `:user`,
  // so keep the prefix greedy and anchor the control marker near the end.
  const canonical = /^(.*):user(?::.*)?$/u.exec(key);
  if (canonical) {
    const derived = normalizeOptionalString(canonical[1]);
    if (derived) {
      target.add(derived);
    }
  }

  // A blocked before_agent_run turn is persisted with the run id after the
  // control marker instead of before it. This row may be the only transcript
  // ownership evidence because no assistant message is produced.
  const hookBlockPrefix = "hook-block:before_agent_run:user:";
  if (key.startsWith(hookBlockPrefix)) {
    const blockedRunId = normalizeOptionalString(key.slice(hookBlockPrefix.length));
    if (blockedRunId) {
      target.add(blockedRunId);
    }
  }

  // Retain the exact idempotency value as a compatibility candidate. It is not
  // trusted as a run id by itself: runtime selection intersects candidates
  // with run ids that actually exist in the trajectory runtime stream.
  target.add(key);
}

function collectMessageRunIds(message: unknown, target: Set<string>): void {
  const persistedRunId = readSessionTranscriptRunId(message);
  if (persistedRunId) {
    target.add(persistedRunId);
  }
  if (!isRecord(message)) {
    return;
  }
  const metadata = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
  const steerTargetRunId = normalizeOptionalString(metadata?.["steerTargetRunId"]);
  if (steerTargetRunId) {
    target.add(steerTargetRunId);
  }
  collectIdempotencyRunIdCandidates(message, target);
}

function collectEntryRunIds(entries: readonly SessionEntry[]): Set<string> {
  const runIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "message") {
      collectMessageRunIds(entry.message, runIds);
      continue;
    }
    if (entry.type === "compaction") {
      const runId = normalizeOptionalString(entry.__openclaw?.runId);
      if (runId) {
        runIds.add(runId);
      }
    }
  }
  return runIds;
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} has an invalid timestamp`);
  }
  return timestamp;
}

function selectRuntimeEventsByRunOwnership(params: {
  selectedEntries: readonly SessionEntry[];
  activeBranchEntries: readonly SessionEntry[];
  allEntries?: readonly SessionEntry[];
  runtimeEvents: readonly TrajectoryEvent[];
  startAt: string;
}): { events: TrajectoryEvent[]; runIds: string[] } {
  if (params.runtimeEvents.length === 0) {
    return { events: [], runIds: [] };
  }

  const runtimeRunIds = new Set(
    params.runtimeEvents
      .map((event) => normalizeOptionalString(event.runId))
      .filter((runId): runId is string => Boolean(runId)),
  );
  const selectedCandidates = collectEntryRunIds(params.selectedEntries);
  const selectedRunIds = new Set(
    [...selectedCandidates].filter((candidate) => runtimeRunIds.has(candidate)),
  );

  const selectedEntryIds = new Set(params.selectedEntries.map((entry) => entry.id));
  const activeBranchIds = new Set(params.activeBranchEntries.map((entry) => entry.id));
  const knownNonSelectedRunIds = collectEntryRunIds(
    (params.allEntries ?? params.activeBranchEntries).filter(
      (entry) => !selectedEntryIds.has(entry.id),
    ),
  );

  if (params.allEntries) {
    const offBranchRunIds = collectEntryRunIds(
      params.allEntries.filter((entry) => !activeBranchIds.has(entry.id)),
    );
    const sharedRunId = [...selectedRunIds].find((runId) => offBranchRunIds.has(runId));
    if (sharedRunId) {
      throw new Error(
        `Cannot safely scope current conversation runtime events because run ${sharedRunId} is shared with an off-branch transcript entry`,
      );
    }
  }

  const startMs = parseTimestamp(params.startAt, "Current conversation start");
  const unownedCurrentRuntime: TrajectoryEvent[] = [];
  const unknownCurrentRuntime: TrajectoryEvent[] = [];
  const selectedRuntime: TrajectoryEvent[] = [];
  for (const event of params.runtimeEvents) {
    const runId = normalizeOptionalString(event.runId);
    if (runId && selectedRunIds.has(runId)) {
      selectedRuntime.push(event);
      continue;
    }

    const eventMs = parseTimestamp(event.ts, "Runtime event");
    if (eventMs < startMs) {
      continue;
    }
    if (!runId) {
      unownedCurrentRuntime.push(event);
      continue;
    }
    if (!knownNonSelectedRunIds.has(runId)) {
      unknownCurrentRuntime.push(event);
    }
  }

  if (unownedCurrentRuntime.length > 0) {
    throw new Error(
      `Cannot safely scope current conversation runtime events: ${unownedCurrentRuntime.length} post-boundary runtime event(s) have no runId`,
    );
  }
  if (unknownCurrentRuntime.length > 0) {
    const unknownIds = [
      ...new Set(
        unknownCurrentRuntime
          .map((event) => normalizeOptionalString(event.runId))
          .filter((runId): runId is string => Boolean(runId)),
      ),
    ];
    throw new Error(
      `Cannot safely scope current conversation runtime events: ${unknownCurrentRuntime.length} post-boundary runtime event(s) belong to ${unknownIds.length} run(s) with no transcript ownership`,
    );
  }
  if (selectedRuntime.length === 0 && selectedRunIds.size === 0) {
    const hasPostBoundaryRuntime = params.runtimeEvents.some(
      (event) => parseTimestamp(event.ts, "Runtime event") >= startMs,
    );
    if (hasPostBoundaryRuntime) {
      throw new Error(
        "Cannot safely scope current conversation runtime events because the active branch exposes no run ownership",
      );
    }
  }

  return { events: selectedRuntime, runIds: [...selectedRunIds].toSorted() };
}

/**
 * Select the visible conversation epoch on the already-resolved active branch.
 * Runtime evidence is joined by persisted run ownership rather than timestamp,
 * so later abandoned branches cannot leak into a current-conversation export.
 */
export function selectCurrentConversation(
  branchEntries: readonly SessionEntry[],
  runtimeEvents: readonly TrajectoryEvent[],
  options: { allEntries?: readonly SessionEntry[] } = {},
): CurrentConversationSelection {
  const resetIndex = branchEntries.findLastIndex((entry) => entry.type === "reset");
  let selectedEntries: SessionEntry[];
  let resetBoundaryAt: string | undefined;
  let resetBoundaryEntryId: string | undefined;
  let conversationStartedAt: string | undefined;

  if (resetIndex < 0) {
    selectedEntries = [...branchEntries];
    conversationStartedAt = selectedEntries[0]?.timestamp;
  } else {
    const reset = branchEntries[resetIndex]!;
    const firstUserIndex = branchEntries.findIndex(
      (entry, index) => index > resetIndex && isDirectUserMessage(entry),
    );
    if (firstUserIndex < 0) {
      throw new Error("Current conversation has no direct user message after the latest reset");
    }
    const firstUser = branchEntries[firstUserIndex]!;
    parseTimestamp(firstUser.timestamp, "Current conversation start");
    selectedEntries = branchEntries.slice(firstUserIndex);
    resetBoundaryAt = reset.timestamp;
    resetBoundaryEntryId = reset.id;
    conversationStartedAt = firstUser.timestamp;
  }

  const startAt = conversationStartedAt ?? new Date(0).toISOString();
  const runtimeSelection = selectRuntimeEventsByRunOwnership({
    selectedEntries,
    activeBranchEntries: branchEntries,
    allEntries: options.allEntries,
    runtimeEvents,
    startAt,
  });

  return {
    entries: selectedEntries,
    runtimeEvents: runtimeSelection.events,
    runIds: runtimeSelection.runIds,
    resetBoundaryAt,
    resetBoundaryEntryId,
    conversationStartedAt,
  };
}
