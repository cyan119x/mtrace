import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import { selectCurrentConversation } from "./current-conversation.js";
import type { TrajectoryEvent } from "./types.js";

const at = (second: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, second)).toISOString();
const entry = (id: string, second: number, type: "reset" | "message", message?: unknown) =>
  ({ id, type, timestamp: at(second), parentId: null, reason: "reset", message }) as SessionEntry;
const user = (id: string, second: number, content: string, provenance?: unknown) =>
  entry(id, second, "message", { role: "user", content, provenance });
const assistant = (id: string, second: number) =>
  entry(id, second, "message", { role: "assistant", content: "ack" });
const runtime = (id: string, second: number) =>
  ({
    source: "runtime",
    type: "prompt.submitted",
    ts: at(second),
    data: { prompt: id },
  }) as TrajectoryEvent;

describe("current conversation active-branch projection", () => {
  it("keeps only C from A → reset → B → reset → C", () => {
    const selected = selectCurrentConversation(
      [
        user("A", 1, "A"),
        entry("r1", 2, "reset"),
        user("B", 3, "B"),
        entry("r2", 4, "reset"),
        user("control", 5, "/reset"),
        assistant("ack", 6),
        user("C", 7, "C"),
        assistant("reply", 9),
      ],
      [runtime("old", 3), runtime("current", 8)],
    );
    expect(selected.entries.map((value) => value.id)).toEqual(["C", "reply"]);
    expect(selected.runtimeEvents.map((value) => value.data?.prompt)).toEqual(["current"]);
    expect(selected.resetBoundaryEntryId).toBe("r2");
    expect(selected.conversationStartedAt).toBe(at(7));
  });

  it("ignores a reset on an abandoned branch because it is not on the supplied active branch", () => {
    const selected = selectCurrentConversation(
      [user("A", 1, "A"), entry("active-reset", 2, "reset"), user("C", 5, "C")],
      [runtime("old", 1), runtime("new", 6)],
    );
    expect(selected.resetBoundaryEntryId).toBe("active-reset");
    expect(selected.entries.map((value) => value.id)).toEqual(["C"]);
  });

  it("returns the full active branch when there is no reset", () => {
    const selected = selectCurrentConversation([user("A", 1, "A")], [runtime("A", 2)]);
    expect(selected.entries.map((value) => value.id)).toEqual(["A"]);
    expect(selected.runtimeEvents).toHaveLength(1);
    expect(selected.resetBoundaryAt).toBeUndefined();
  });

  it("fails closed when reset has no direct post-reset user", () => {
    expect(() =>
      selectCurrentConversation(
        [
          user("A", 1, "A"),
          entry("reset", 2, "reset"),
          user("control", 3, "/reset"),
          assistant("ack", 4),
          user("inter", 5, "inter", { kind: "inter_session" }),
        ],
        [],
      ),
    ).toThrow(/no direct user/);
  });
});
