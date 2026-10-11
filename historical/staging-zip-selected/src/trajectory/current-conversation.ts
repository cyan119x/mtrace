import type { SessionEntry } from "../agents/sessions/session-manager.js";
import type { TrajectoryEvent } from "./types.js";

export type CurrentConversationSelection = {
  entries: SessionEntry[];
  runtimeEvents: TrajectoryEvent[];
  resetBoundaryAt?: string;
  resetBoundaryEntryId?: string;
  conversationStartedAt?: string;
};

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
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part): part is { type: string; text: string } =>
                part?.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join(" ")
        : "";
  return !/^\/reset(?:\s|$)/i.test(text.trim());
}

/** Only the already-resolved active branch may establish the reset boundary. */
export function selectCurrentConversation(
  branchEntries: readonly SessionEntry[],
  runtimeEvents: readonly TrajectoryEvent[],
): CurrentConversationSelection {
  const resetIndex = branchEntries.findLastIndex((entry) => entry.type === "reset");
  if (resetIndex < 0) {
    return { entries: [...branchEntries], runtimeEvents: [...runtimeEvents] };
  }
  const reset = branchEntries[resetIndex]!;
  const firstUserIndex = branchEntries.findIndex(
    (entry, index) => index > resetIndex && isDirectUserMessage(entry),
  );
  if (firstUserIndex < 0) {
    throw new Error("Current conversation has no direct user message after the latest reset");
  }
  const firstUser = branchEntries[firstUserIndex]!;
  const startMs = Date.parse(firstUser.timestamp);
  if (!Number.isFinite(startMs)) {
    throw new Error("Current conversation start has an invalid timestamp");
  }
  const selectedRuntime = runtimeEvents.filter((event) => {
    const eventMs = Date.parse(event.ts);
    if (!Number.isFinite(eventMs)) {
      throw new Error("Runtime event has an invalid timestamp; cannot safely scope export");
    }
    return eventMs >= startMs;
  });
  return {
    entries: branchEntries.slice(firstUserIndex),
    runtimeEvents: selectedRuntime,
    resetBoundaryAt: reset.timestamp,
    resetBoundaryEntryId: reset.id,
    conversationStartedAt: firstUser.timestamp,
  };
}
