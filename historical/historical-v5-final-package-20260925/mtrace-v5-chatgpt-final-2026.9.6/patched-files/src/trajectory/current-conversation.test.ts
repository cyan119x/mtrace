import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../agents/sessions/session-manager.js";
import { selectCurrentConversation } from "./current-conversation.js";
import type { TrajectoryEvent } from "./types.js";

const at = (second: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, second)).toISOString();
const entry = (id: string, second: number, type: "reset" | "message", message?: unknown) =>
  ({ id, type, timestamp: at(second), parentId: null, reason: "reset", message }) as SessionEntry;
const user = (
  id: string,
  second: number,
  content: string,
  runId: string,
  provenance?: unknown,
) =>
  entry(id, second, "message", {
    role: "user",
    content,
    provenance,
    idempotencyKey: `${runId}:user`,
  });
const assistant = (id: string, second: number, runId: string) =>
  entry(id, second, "message", {
    role: "assistant",
    content: "ack",
    __openclaw: { runId },
  });
const runtime = (id: string, second: number, runId?: string) =>
  ({
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "session",
    sessionId: "session",
    source: "runtime",
    type: "prompt.submitted",
    ts: at(second),
    seq: second,
    sourceSeq: second,
    runId,
    data: { prompt: id },
  }) as TrajectoryEvent;

describe("current conversation active-branch projection", () => {
  it("keeps only C from A → reset → B → reset → C and joins runtime by runId", () => {
    const branch = [
      user("A", 1, "A", "run-a"),
      entry("r1", 2, "reset"),
      user("B", 3, "B", "run-b"),
      entry("r2", 4, "reset"),
      user("control", 5, "/reset", "reset-control"),
      assistant("ack", 6, "reset-control"),
      user("C", 7, "C", "run-c"),
      assistant("reply", 9, "run-c"),
    ];
    const selected = selectCurrentConversation(
      branch,
      [runtime("old", 8, "run-b"), runtime("current", 8, "run-c")],
      { allEntries: branch },
    );
    expect(selected.entries.map((value) => value.id)).toEqual(["C", "reply"]);
    expect(selected.runtimeEvents.map((value) => value.data?.prompt)).toEqual(["current"]);
    expect(selected.runIds).toEqual(["run-c"]);
    expect(selected.resetBoundaryEntryId).toBe("r2");
    expect(selected.conversationStartedAt).toBe(at(7));
  });

  it("excludes an interleaved abandoned branch by run ownership", () => {
    const branch = [
      user("A", 1, "A", "run-a"),
      entry("reset", 2, "reset"),
      user("C", 5, "C", "run-current"),
      assistant("answer", 8, "run-current"),
    ];
    const abandoned = user("abandoned", 6, "ABANDONED", "run-abandoned");
    const selected = selectCurrentConversation(
      branch,
      [runtime("abandoned", 7, "run-abandoned"), runtime("current", 7, "run-current")],
      { allEntries: [...branch, abandoned] },
    );
    expect(selected.entries.map((value) => value.id)).toEqual(["C", "answer"]);
    expect(selected.runtimeEvents.map((value) => value.data?.prompt)).toEqual(["current"]);
  });

  it("fails closed if a run id is shared by selected and off-branch entries", () => {
    const branch = [
      user("A", 1, "A", "run-a"),
      entry("reset", 2, "reset"),
      user("C", 5, "C", "shared-run"),
      assistant("answer", 8, "shared-run"),
    ];
    const abandoned = user("abandoned", 6, "ABANDONED", "shared-run");
    expect(() =>
      selectCurrentConversation(branch, [runtime("shared", 7, "shared-run")], {
        allEntries: [...branch, abandoned],
      }),
    ).toThrow(/shared with an off-branch/);
  });


  it("maps a before_agent_run blocked user row back to its runtime run id", () => {
    const branch = [
      user("A", 1, "A", "run-a"),
      entry("reset", 2, "reset"),
      user("C", 5, "C", "run-c"),
      entry("blocked", 6, "message", {
        role: "user",
        content: "blocked before agent run",
        idempotencyKey: "hook-block:before_agent_run:user:run-blocked",
      }),
    ];
    const selected = selectCurrentConversation(
      branch,
      [runtime("current", 5, "run-c"), runtime("blocked", 6, "run-blocked")],
      { allEntries: branch },
    );
    expect(selected.runIds).toEqual(["run-blocked", "run-c"]);
    expect(selected.runtimeEvents.map((value) => value.data?.prompt)).toEqual([
      "current",
      "blocked",
    ]);
  });

  it("fails closed for post-boundary runtime whose run id has no transcript owner", () => {
    const branch = [
      user("A", 1, "A", "run-a"),
      entry("reset", 2, "reset"),
      user("C", 5, "C", "run-c"),
    ];
    expect(() =>
      selectCurrentConversation(
        branch,
        [runtime("current", 5, "run-c"), runtime("mystery", 6, "run-mystery")],
        { allEntries: branch },
      ),
    ).toThrow(/no transcript ownership/);
  });

  it("fails closed for post-boundary runtime evidence without run ownership", () => {
    const branch = [
      user("A", 1, "A", "run-a"),
      entry("reset", 2, "reset"),
      user("C", 5, "C", "run-c"),
    ];
    expect(() =>
      selectCurrentConversation(branch, [runtime("unowned", 6)], { allEntries: branch }),
    ).toThrow(/have no runId/);
  });

  it("ignores a reset on an abandoned branch because it is not on the supplied active branch", () => {
    const branch = [
      user("A", 1, "A", "run-a"),
      entry("active-reset", 2, "reset"),
      user("C", 5, "C", "run-c"),
    ];
    const abandonedReset = entry("abandoned-reset", 4, "reset");
    const selected = selectCurrentConversation(
      branch,
      [runtime("old", 1, "run-a"), runtime("new", 6, "run-c")],
      { allEntries: [...branch, abandonedReset] },
    );
    expect(selected.resetBoundaryEntryId).toBe("active-reset");
    expect(selected.entries.map((value) => value.id)).toEqual(["C"]);
  });

  it("returns the full active branch when there is no reset while excluding off-branch runtime", () => {
    const branch = [user("A", 1, "A", "run-a"), assistant("reply", 3, "run-a")];
    const abandoned = user("fork", 2, "fork", "run-fork");
    const selected = selectCurrentConversation(
      branch,
      [runtime("A", 2, "run-a"), runtime("fork", 2, "run-fork")],
      { allEntries: [...branch, abandoned] },
    );
    expect(selected.entries.map((value) => value.id)).toEqual(["A", "reply"]);
    expect(selected.runtimeEvents.map((value) => value.data?.prompt)).toEqual(["A"]);
    expect(selected.resetBoundaryAt).toBeUndefined();
  });

  it("fails closed when reset has no direct post-reset user", () => {
    expect(() =>
      selectCurrentConversation(
        [
          user("A", 1, "A", "run-a"),
          entry("reset", 2, "reset"),
          user("control", 3, "/reset", "reset-run"),
          assistant("ack", 4, "reset-run"),
          user("inter", 5, "inter", "announce-run", { kind: "inter_session" }),
        ],
        [],
      ),
    ).toThrow(/no direct user/);
  });
});
