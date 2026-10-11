import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockHttpResponse } from "./test-http-response.js";

const state = vi.hoisted(() => ({
  agentIds: ["main"] as string[],
  auth: vi.fn(),
  entry: {
    sessionId: "11111111-2222-4333-8444-555555555555",
    lifecycleRevision: "generation-a",
  } as {
    sessionId?: string;
    lifecycleRevision?: string;
  },
  exportTrajectory: vi.fn(),
  resolveKey: vi.fn(),
  workspace: "",
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: () => state.agentIds,
  resolveAgentWorkspaceDir: () => state.workspace,
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({ session: {} }) }));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (_configured: unknown, scope: { agentId: string }) =>
    `/state/${scope.agentId}.sqlite`,
}));
vi.mock("../config/sessions/session-accessor.sqlite-entry.js", () => ({
  loadSessionEntryReadOnly: () => state.entry,
  resolveSessionKeyBySessionId: (scope: { agentId: string }) => state.resolveKey(scope.agentId),
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  resolveSessionTranscriptReadTarget: (scope: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => scope,
}));
vi.mock("../trajectory/command-export.js", () => ({
  exportTrajectoryForCommand: (...args: unknown[]) => state.exportTrajectory(...args),
}));
vi.mock("./http-utils.js", () => ({
  authorizeControlUiReadRequestOrReply: (...args: unknown[]) => state.auth(...args),
}));

import { handleMtraceHttpRequest, type MtraceExportMode } from "./mtrace-http.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_KEY = "agent:main:dashboard:current";
let temp = "";
let outputDir = "";
let omitOptional = false;

async function writeBundle(current = false) {
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const events = [
    '{"source":"transcript","type":"user.message","ts":"2026-09-11T00:00:00.000Z","entryId":"old-user","data":{"message":{"role":"user","content":"OLD EPOCH SHOULD NOT LEAK"}}}',
    '{"source":"runtime","type":"session.started","ts":"2026-09-11T00:00:00.100Z","runId":"old-run"}',
    '{"source":"transcript","type":"assistant.message","ts":"2026-09-11T00:00:00.200Z","entryId":"old-assistant","data":{"message":{"role":"assistant","content":"OLD ASSISTANT"}}}',
    '{"source":"transcript","type":"session.reset","ts":"2026-09-19T02:52:20.111Z","entryId":"reset-latest","data":{"reason":"reset"}}',
    '{"source":"transcript","type":"user.message","ts":"2026-09-19T02:52:20.427Z","entryId":"reset-command","data":{"message":{"role":"user","content":"/reset"}}}',
    '{"source":"transcript","type":"assistant.message","ts":"2026-09-19T02:52:20.457Z","entryId":"reset-ack","data":{"message":{"role":"assistant","content":[{"type":"text","text":"✅ Session reset."}]}}}',
    '{"source":"transcript","type":"user.message","ts":"2026-09-19T02:52:45.277Z","entryId":"current-user","data":{"message":{"role":"user","content":"CURRENT EPOCH START"}}}',
    '{"source":"runtime","type":"session.started","ts":"2026-09-19T02:52:45.300Z","runId":"current-run"}',
    '{"source":"transcript","type":"tool.call","ts":"2026-09-19T02:52:46.000Z","entryId":"current-tool","data":{"name":"exec"}}',
    '{"source":"runtime","type":"tool.result","ts":"2026-09-19T02:52:46.500Z","runId":"current-run","data":{"nested":{"source":"transcript"}},"invalid":}',
    '{"source":"transcript","type":"assistant.message","ts":"2026-09-19T02:52:47.000Z","entryId":"current-assistant","data":{"message":{"role":"assistant","content":"CURRENT EPOCH END"},"nested":{"source":"runtime"}}}',
  ];
  const files: Record<string, string> = {
    "metadata.json": current ? "metadata-current-only" : "metadata-raw",
    "artifacts.json": current ? "artifacts-current-only" : "artifacts-raw",
    "prompts.json": current ? "prompts-current-only" : "prompts-old-and-current-raw",
    "system-prompt.txt": current ? "system-prompt-current-only" : "system-prompt-raw",
    "tools.json": current ? "tools-current-only" : "tools-raw",
    "events.jsonl": `${(current ? events.slice(6) : events).join("\n")}\n`,
    "session-branch.json": 'session-branch-old-root\n"[Truncated]"\n',
  };
  if (current) {
    delete files["session-branch.json"];
  }
  if (omitOptional) {
    delete files["system-prompt.txt"];
    delete files["tools.json"];
  }
  files["manifest.json"] = JSON.stringify({
    ...(current
      ? {
          selectionScope: "current-conversation",
          resetBoundaryAt: "2026-09-19T02:52:20.111Z",
          resetBoundaryEntryId: "reset-latest",
          conversationStartedAt: "2026-09-19T02:52:45.277Z",
        }
      : {}),
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    generatedAt: "2026-09-24T00:00:00.000Z",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    contents: Object.keys(files).map((file) => ({ path: file })),
  });
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await fs.writeFile(path.join(outputDir, name), content, { mode: 0o600 });
    }),
  );
}

function request(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): {
  encoded: Buffer;
  req: IncomingMessage;
  stream: PassThrough;
} {
  const encoded = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const stream = new PassThrough({ autoDestroy: false });
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  Object.defineProperty(req, "socket", {
    configurable: true,
    value: new PassThrough({ autoDestroy: false }),
  });
  req.headers = {
    "content-type": "application/json",
    "content-length": String(encoded.length),
  };
  return { encoded, req, stream };
}

async function invoke(method: string, url: string, body?: Record<string, unknown>) {
  const response = makeMockHttpResponse();
  const chunks: Buffer[] = [];
  response.res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
  const ended = new Promise<void>((resolve) => {
    response.res.once("end", () => {
      resolve();
    });
  });
  const input = request(method, url, body);
  const handledPromise = handleMtraceHttpRequest(input.req, response.res, {});
  input.stream.end(input.encoded);
  const handled = await handledPromise;
  await ended;
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    handled,
    status: response.res.statusCode,
    text,
    payload: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : null,
    setHeader: response.setHeader,
  };
}

function exportBody(mode: MtraceExportMode): Record<string, unknown> {
  return {
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    lifecycleRevision: "generation-a",
    mode,
  };
}

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "mtrace-http-test-"));
  state.workspace = temp;
  outputDir = path.join(temp, ".openclaw", "trajectory-exports", "fixture");
  omitOptional = false;
  await writeBundle();
  state.agentIds = ["main"];
  state.entry = { sessionId: SESSION_ID, lifecycleRevision: "generation-a" };
  state.auth.mockReset().mockResolvedValue({ operatorScopes: ["operator.read"] });
  state.resolveKey
    .mockReset()
    .mockImplementation((agentId: string) => (agentId === "main" ? SESSION_KEY : undefined));
  state.exportTrajectory
    .mockReset()
    .mockImplementation(async (params: { conversationScope?: "current" }) => {
      const current = params.conversationScope === "current";
      await writeBundle(current);
      return {
        outputDir,
        displayPath: ".openclaw/trajectory-exports/fixture",
        sessionId: SESSION_ID,
        eventCount: current ? 5 : 11,
        runtimeEventCount: current ? 2 : 3,
        transcriptEventCount: current ? 3 : 8,
        files: [
          "manifest.json",
          "events.jsonl",
          "session-branch.json",
          "system-prompt.txt",
          "tools.json",
          "metadata.json",
          "artifacts.json",
          "prompts.json",
        ],
      };
    });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temp, { recursive: true, force: true });
});

describe("Mtrace HTTP export", () => {
  it.each<{
    mode: MtraceExportMode;
    includes: string[];
    excludes: string[];
    scope: "since-last-reset" | "full-session";
    eventCount: number;
    runtimeEventCount: number;
    transcriptEventCount: number;
  }>([
    {
      mode: "full",
      includes: [
        "current-events.jsonl",
        "metadata.json",
        "artifacts.json",
        "prompts.json",
        "system-prompt.txt",
        "tools.json",
      ],
      excludes: ["session-branch.json"],
      scope: "since-last-reset",
      eventCount: 5,
      runtimeEventCount: 2,
      transcriptEventCount: 3,
    },
    {
      mode: "transcript",
      includes: ["current-transcript.jsonl"],
      excludes: ["events.jsonl", "session-branch.json", "prompts.json", "tools.json"],
      scope: "since-last-reset",
      eventCount: 5,
      runtimeEventCount: 2,
      transcriptEventCount: 3,
    },
    {
      mode: "prompt-tool-runtime",
      includes: [
        "current-prompt-tool-runtime.jsonl",
        "metadata.json",
        "artifacts.json",
        "prompts.json",
        "system-prompt.txt",
        "tools.json",
      ],
      excludes: ["session-branch.json"],
      scope: "since-last-reset",
      eventCount: 5,
      runtimeEventCount: 2,
      transcriptEventCount: 3,
    },
    {
      mode: "history",
      includes: ["events.jsonl", "session-branch.json", "prompts.json", "tools.json"],
      excludes: [],
      scope: "full-session",
      eventCount: 11,
      runtimeEventCount: 3,
      transcriptEventCount: 8,
    },
  ])(
    "builds the exact $mode artifact inventory and scope",
    async ({
      mode,
      includes,
      excludes,
      scope,
      eventCount,
      runtimeEventCount,
      transcriptEventCount,
    }) => {
      const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody(mode));
      expect(result.handled).toBe(true);
      expect(result.status, JSON.stringify(result.payload)).toBe(200);
      expect(result.payload).toMatchObject({
        mode,
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        scope,
        eventCount,
        runtimeEventCount,
        transcriptEventCount,
      });
      const includedFiles = result.payload?.includedFiles as string[];
      expect(includedFiles).toContain("manifest.json");
      for (const file of includes) {
        expect(includedFiles).toContain(file);
      }
      for (const file of excludes) {
        expect(includedFiles).not.toContain(file);
      }

      const markdownFiles = (await fs.readdir(outputDir)).filter((file) => file.endsWith(".md"));
      expect(markdownFiles).toHaveLength(1);
      const markdown = await fs.readFile(path.join(outputDir, markdownFiles[0]!), "utf8");
      expect(markdown).toContain(`mode: ${mode}`);
      expect(markdown).toContain(`scope: ${scope}`);
      expect(markdown).toContain(`session_id: ${SESSION_ID}`);
      expect(markdown).toContain(`session_key: ${SESSION_KEY}`);
      for (const file of includes) {
        expect(markdown).toContain(`BEGIN FILE: ${file}`);
      }
      for (const file of excludes) {
        expect(markdown).not.toContain(`BEGIN FILE: ${file}`);
      }

      if (mode === "history") {
        expect(markdown).toContain("OLD EPOCH SHOULD NOT LEAK");
        expect(markdown).toContain('"[Truncated]"');
      } else {
        expect(markdown).not.toContain("OLD EPOCH SHOULD NOT LEAK");
        expect(markdown).not.toContain('"[Truncated]"');
        expect(markdown).toContain("CURRENT EPOCH START");
        expect(markdown).toContain("2026-09-19T02:52:20.111Z");
        expect(markdown).toContain("2026-09-19T02:52:45.277Z");
      }
      if (mode === "full" || mode === "prompt-tool-runtime") {
        expect(markdown).toContain('{"source":"runtime","type":"tool.result"');
        expect(markdown).toContain('"invalid":}');
      }
    },
  );

  it("uses the latest reset and excludes the reset control exchange itself", async () => {
    const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("transcript"));
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      scope: "since-last-reset",
      resetBoundaryAt: "2026-09-19T02:52:20.111Z",
      conversationStartedAt: "2026-09-19T02:52:45.277Z",
    });
    const markdownFile = (await fs.readdir(outputDir)).find((file) => file.endsWith(".md"));
    if (!markdownFile) {
      throw new Error("Expected an MTrace Markdown export");
    }
    const markdown = await fs.readFile(path.join(outputDir, markdownFile), "utf8");
    expect(markdown).toContain("CURRENT EPOCH START");
    expect(markdown).not.toContain('"content":"/reset"');
    expect(markdown).not.toContain("✅ Session reset.");
  });

  it("uses the manifest inventory when a legacy summary claims optional prompt files", async () => {
    omitOptional = true;
    await fs.rm(path.join(outputDir, "system-prompt.txt"));
    await fs.rm(path.join(outputDir, "tools.json"));
    const manifestPath = path.join(outputDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      contents: Array<{ path: string }>;
    };
    manifest.contents = manifest.contents.filter(
      ({ path: file }) => file !== "system-prompt.txt" && file !== "tools.json",
    );
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

    for (const mode of ["full", "prompt-tool-runtime", "history"] as const) {
      const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody(mode));
      expect(result.status, JSON.stringify(result.payload)).toBe(200);
      expect(result.payload?.includedFiles).not.toContain("system-prompt.txt");
      expect(result.payload?.includedFiles).not.toContain("tools.json");
    }
  });

  it("exports only after exact agent, session id, and canonical key verification", async () => {
    const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    expect(result.status).toBe(200);
    expect(state.resolveKey).toHaveBeenCalledWith("main");
    expect(state.exportTrajectory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        workspaceDir: temp,
      }),
    );
    expect(state.resolveKey).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the displayed session identity is stale", async () => {
    state.entry = { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    expect(result.status).toBe(400);
    expect(result.payload?.error).toContain("did not match");
    expect(state.exportTrajectory).not.toHaveBeenCalled();
  });

  it("fails closed when the session generation changed after a reset", async () => {
    state.entry = { sessionId: SESSION_ID, lifecycleRevision: "generation-b" };
    const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    expect(result.status).toBe(400);
    expect(result.payload?.error).toContain("generation changed");
    expect(state.exportTrajectory).not.toHaveBeenCalled();
  });

  it("fails closed when one Session ID resolves in more than one agent", async () => {
    state.agentIds = ["main", "other"];
    state.resolveKey.mockImplementation((agentId: string) =>
      agentId === "main" ? SESSION_KEY : "agent:other:dashboard:duplicate",
    );
    const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    expect(result.status).toBe(400);
    expect(result.payload?.error).toContain("resolved to 2 canonical targets");
    expect(state.exportTrajectory).not.toHaveBeenCalled();
  });

  it("rejects incomplete or unsupported export requests", async () => {
    const missing = await invoke("POST", "/__openclaw__/mtrace/export", {
      sessionId: SESSION_ID,
    });
    expect(missing.status).toBe(400);
    const unsupported = await invoke("POST", "/__openclaw__/mtrace/export", {
      ...exportBody("full"),
      mode: "latest-run",
    });
    expect(unsupported.status).toBe(400);
    expect(state.exportTrajectory).not.toHaveBeenCalled();
  });

  it("enforces authentication before reading identity or exporting", async () => {
    state.auth.mockImplementationOnce(
      ({ res }: { res: { statusCode: number; end: () => void } }) => {
        res.statusCode = 401;
        res.end();
        return null;
      },
    );
    const result = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    expect(result.status).toBe(401);
    expect(state.resolveKey).not.toHaveBeenCalled();
    expect(state.exportTrajectory).not.toHaveBeenCalled();
  });

  it("serves a no-store one-time download and removes the generated Markdown", async () => {
    const created = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    const artifactId = String(created.payload?.artifactId);
    const markdownPath = path.join(outputDir, String(created.payload?.filename));
    expect((await fs.stat(markdownPath)).isFile()).toBe(true);

    const downloaded = await invoke("GET", `/__openclaw__/mtrace/download/${artifactId}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.text).toContain("===== BEGIN MTRACE EXPORT =====");
    expect(downloaded.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(downloaded.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    await expect(fs.stat(markdownPath)).rejects.toThrow();

    const replay = await invoke("GET", `/__openclaw__/mtrace/download/${artifactId}`);
    expect(replay.status).toBe(404);
  });

  it("retires a download after the same session is reset to a new generation", async () => {
    const created = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    const artifactId = String(created.payload?.artifactId);
    state.entry = { sessionId: SESSION_ID, lifecycleRevision: "generation-b" };

    const downloaded = await invoke("GET", `/__openclaw__/mtrace/download/${artifactId}`);
    expect(downloaded.status).toBe(404);
  });

  it("expires the opaque download reference after 30 minutes", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const created = await invoke("POST", "/__openclaw__/mtrace/export", exportBody("full"));
    const artifactId = String(created.payload?.artifactId);
    const markdownPath = path.join(outputDir, String(created.payload?.filename));
    clock.mockReturnValue(now + 30 * 60_000 + 1);

    const expired = await invoke("GET", `/__openclaw__/mtrace/download/${artifactId}`);
    expect(expired.status).toBe(404);
    await expect(fs.stat(markdownPath)).rejects.toThrow();
  });
});
