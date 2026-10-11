import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportTrajectoryBundle } from "./export.js";
import { userMessage, assistantMessage } from "./export.test-helpers.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mtrace-typed-export-"));
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function runtime(id: string, ts: string, seq: number, runId: string) {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "session-1",
    source: "runtime",
    type: "prompt.submitted",
    ts,
    seq,
    sourceSeq: seq,
    sessionId: "session-1",
    runId,
    data: { prompt: id },
  };
}

function persistedUser(content: string, runId: string) {
  return { ...userMessage(content), idempotencyKey: `${runId}:user` };
}

function persistedAssistant(content: string, runId: string) {
  return {
    ...assistantMessage([{ type: "text" as const, text: content }]),
    __openclaw: { runId },
  };
}

describe("typed current-conversation bundle", () => {
  it("excludes old epoch from emitted files while explicit history retains it", async () => {
    const sessionFile = path.join(root, "session.jsonl");
    const runtimeFile = path.join(root, "runtime.jsonl");
    const ts = (n: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, n)).toISOString();
    const entries = [
      { type: "session", version: 3, id: "session-1", timestamp: ts(0), cwd: root },
      {
        type: "message",
        id: "old",
        parentId: null,
        timestamp: ts(1),
        message: persistedUser("OLD EPOCH MUST NOT LEAK", "run-old"),
      },
      { type: "reset", id: "reset", parentId: "old", timestamp: ts(2), reason: "reset" },
      {
        type: "message",
        id: "control",
        parentId: "reset",
        timestamp: ts(3),
        message: persistedUser("/reset", "run-reset"),
      },
      {
        type: "message",
        id: "ack",
        parentId: "control",
        timestamp: ts(4),
        message: persistedAssistant("Reset complete", "run-reset"),
      },
      {
        type: "message",
        id: "current",
        parentId: "ack",
        timestamp: ts(5),
        message: persistedUser("CURRENT EPOCH START", "run-current"),
      },
      {
        type: "message",
        id: "answer",
        parentId: "current",
        timestamp: ts(7),
        message: persistedAssistant("CURRENT EPOCH END", "run-current"),
      },
    ];
    await fs.writeFile(sessionFile, entries.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await fs.writeFile(
      runtimeFile,
      [
        runtime("OLD EPOCH PROMPT", ts(6), 1, "run-old"),
        runtime("CURRENT PROMPT", ts(6), 2, "run-current"),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const current = await exportTrajectoryBundle({
      outputDir: path.join(root, "current"),
      sessionFile,
      runtimeFile,
      sessionId: "session-1",
      workspaceDir: root,
      conversationScope: "current",
    });
    expect(current.manifest.selectionScope).toBe("current-conversation");
    expect(current.manifest.resetBoundaryEntryId).toBe("reset");
    expect(current.manifest.conversationStartedAt).toBe(ts(5));
    expect(current.manifest.runtimeCorrelation).toBe("active-branch-run-id");
    expect(current.manifest.runtimeEventCount).toBe(1);
    for (const file of current.files) {
      const data = await fs.readFile(path.join(current.outputDir, file), "utf8");
      expect(data, file).not.toContain("OLD EPOCH");
      expect(data, file).not.toContain("Reset complete");
    }
    const history = await exportTrajectoryBundle({
      outputDir: path.join(root, "history"),
      sessionFile,
      runtimeFile,
      sessionId: "session-1",
      workspaceDir: root,
    });
    expect(await fs.readFile(path.join(history.outputDir, "events.jsonl"), "utf8")).toContain(
      "OLD EPOCH",
    );
  });

  it("excludes a later abandoned branch runtime event by run ownership", async () => {
    const sessionFile = path.join(root, "fork-session.jsonl");
    const runtimeFile = path.join(root, "fork-runtime.jsonl");
    const ts = (n: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, n)).toISOString();
    const entries = [
      { type: "session", version: 3, id: "session-1", timestamp: ts(0), cwd: root },
      {
        type: "message",
        id: "old",
        parentId: null,
        timestamp: ts(1),
        message: persistedUser("old", "run-old"),
      },
      { type: "reset", id: "reset", parentId: "old", timestamp: ts(2), reason: "reset" },
      {
        type: "message",
        id: "current",
        parentId: "reset",
        timestamp: ts(5),
        message: persistedUser("current", "run-current"),
      },
      {
        type: "message",
        id: "abandoned",
        parentId: "reset",
        timestamp: ts(6),
        message: persistedUser("ABANDONED BRANCH", "run-abandoned"),
      },
      {
        type: "message",
        id: "answer",
        parentId: "current",
        timestamp: ts(8),
        message: persistedAssistant("answer", "run-current"),
      },
    ];
    await fs.writeFile(sessionFile, entries.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await fs.writeFile(
      runtimeFile,
      [
        runtime("ABANDONED BRANCH", ts(7), 1, "run-abandoned"),
        runtime("CURRENT RUNTIME", ts(7), 2, "run-current"),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const current = await exportTrajectoryBundle({
      outputDir: path.join(root, "fork-current"),
      sessionFile,
      runtimeFile,
      sessionId: "session-1",
      workspaceDir: root,
      conversationScope: "current",
    });
    const events = await fs.readFile(path.join(current.outputDir, "events.jsonl"), "utf8");
    expect(events).toContain("CURRENT RUNTIME");
    expect(events).not.toContain("ABANDONED BRANCH");
    const history = await exportTrajectoryBundle({
      outputDir: path.join(root, "fork-history"),
      sessionFile,
      runtimeFile,
      sessionId: "session-1",
      workspaceDir: root,
    });
    expect(history.manifest.runtimeEventCount).toBe(2);
  });
});
