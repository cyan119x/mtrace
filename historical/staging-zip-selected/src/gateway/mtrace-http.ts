// Authenticated Control UI endpoint for explicit, local-only Mtrace exports.
// The route never starts an agent/model run or mutates the target transcript.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSessionTranscriptReadTarget } from "../config/sessions/session-accessor.js";
import {
  loadSessionEntryReadOnly,
  resolveSessionKeyBySessionId,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { exportTrajectoryForCommand } from "../trajectory/command-export.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { isReadHttpMethod, respondNotFound } from "./control-ui-http-utils.js";
import { readJsonBodyOrError, sendJson } from "./http-common.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";

const MTRACE_ROOT = "/__openclaw__/mtrace";
const MTRACE_ARTIFACT_TTL_MS = 30 * 60_000;
const MTRACE_REQUEST_MAX_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MtraceExportMode = "full" | "transcript" | "prompt-tool-runtime" | "history";

type MtraceArtifact = {
  agentId: string;
  expiresAt: number;
  filePath: string;
  outputDir: string;
  filename: string;
  mode: MtraceExportMode;
  sessionId: string;
  sessionKey: string;
  sizeBytes: number;
  includedFiles: string[];
  lifecycleRevision?: string;
  scope: "since-last-reset" | "full-session";
  resetBoundaryAt?: string;
  conversationStartedAt?: string;
};

type ResolvedMtraceSession = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  entry: NonNullable<ReturnType<typeof loadSessionEntryReadOnly>>;
  lifecycleRevision?: string;
};

const artifacts = new Map<string, MtraceArtifact>();

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeArtifactFile(artifact: MtraceArtifact): Promise<void> {
  await fs.unlink(artifact.filePath).catch(() => undefined);
}

async function purgeExpiredArtifacts(now = Date.now()): Promise<void> {
  const expired: MtraceArtifact[] = [];
  for (const [id, artifact] of artifacts) {
    if (artifact.expiresAt <= now) {
      artifacts.delete(id);
      expired.push(artifact);
    }
  }
  await Promise.all(expired.map(async (artifact) => await removeArtifactFile(artifact)));
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMode(record: Record<string, unknown>): MtraceExportMode | undefined {
  const value = readString(record, "mode");
  return value === "full" ||
    value === "transcript" ||
    value === "prompt-tool-runtime" ||
    value === "history"
    ? value
    : undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type RawEventProjection = {
  allEvents: string;
  transcriptEvents: string;
  promptToolRuntimeEvents: string;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  scope: "since-last-reset" | "full-session";
  resetBoundaryAt?: string;
  resetBoundaryEntryId?: string;
  conversationStartedAt?: string;
};

function isTranscriptEvent(line: string): boolean {
  return line.includes('"source":"transcript"');
}

function isRuntimeEvent(line: string): boolean {
  return line.includes('"source":"runtime"');
}

function isPromptToolRuntimeEvent(line: string): boolean {
  if (isRuntimeEvent(line)) {
    return true;
  }
  return (
    isTranscriptEvent(line) &&
    (line.includes('"type":"tool.call"') ||
      line.includes('"type":"tool.result"') ||
      line.includes('"type":"user.message"') ||
      line.includes('"type":"session.custom_message"'))
  );
}

// The exporter has already selected the typed active branch and matching runtime
// evidence. Parse only compact source/type envelopes here, preserving raw payloads
// (including malformed redaction output); never reselect a conversation by line.
function projectRawEvents(raw: string): RawEventProjection {
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const transcript = lines.filter(isTranscriptEvent);
  const promptToolRuntime = lines.filter(isPromptToolRuntimeEvent);
  return {
    allEvents: lines.join("\n") + (lines.length ? "\n" : ""),
    transcriptEvents: transcript.join("\n") + (transcript.length ? "\n" : ""),
    promptToolRuntimeEvents: promptToolRuntime.join("\n") + (promptToolRuntime.length ? "\n" : ""),
    eventCount: lines.length,
    runtimeEventCount: lines.filter(isRuntimeEvent).length,
    transcriptEventCount: transcript.length,
    scope: "since-last-reset",
  };
}

async function readSafeExportFile(outputDir: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative)) {
    throw new Error(`Mtrace export file is unsafe: ${relative}`);
  }
  const resolvedOutput = path.resolve(outputDir);
  const candidate = path.resolve(resolvedOutput, relative);
  if (!isPathInside(resolvedOutput, candidate)) {
    throw new Error(`Mtrace export file escapes its output directory: ${relative}`);
  }
  const linkStat = await fs.lstat(candidate);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error(`Mtrace export file is missing or unsafe: ${relative}`);
  }
  const [realOutput, realCandidate] = await Promise.all([
    fs.realpath(resolvedOutput),
    fs.realpath(candidate),
  ]);
  if (!isPathInside(realOutput, realCandidate)) {
    throw new Error(`Mtrace export file escapes its real output directory: ${relative}`);
  }
  return await fs.readFile(realCandidate, "utf8");
}

async function buildMtraceMarkdown(params: {
  outputDir: string;
  sessionId: string;
  sessionKey: string;
  lifecycleRevision?: string;
  mode: MtraceExportMode;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  files: string[];
}): Promise<{
  filePath: string;
  filename: string;
  sizeBytes: number;
  includedFiles: string[];
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  scope: "since-last-reset" | "full-session";
  resetBoundaryAt?: string;
  conversationStartedAt?: string;
}> {
  const outputDir = path.resolve(params.outputDir);
  const sourceManifestText = await readSafeExportFile(outputDir, "manifest.json");
  const sourceManifest = JSON.parse(sourceManifestText) as unknown;
  if (
    !isRecord(sourceManifest) ||
    sourceManifest.sessionId !== params.sessionId ||
    sourceManifest.sessionKey !== params.sessionKey
  ) {
    throw new Error("Mtrace export manifest identity did not match the requested session");
  }
  const manifestFiles = Array.isArray(sourceManifest.contents)
    ? sourceManifest.contents.flatMap((entry) =>
        isRecord(entry) && typeof entry.path === "string" ? [entry.path] : [],
      )
    : params.files;
  const available = new Set(["manifest.json", ...manifestFiles]);

  if (!available.has("events.jsonl")) {
    throw new Error(
      "Mtrace export did not produce events.jsonl; current-conversation scope is unavailable",
    );
  }

  if (params.mode === "history") {
    const files = [...available];
    const chunks = [
      "===== BEGIN MTRACE EXPORT =====\n",
      "format: mtrace/session-export-v3\n",
      "mode: history\n",
      "selection: full-sidebar-session-history\n",
      "scope: full-session\n",
      `session_id: ${params.sessionId}\n`,
      `session_key: ${params.sessionKey}\n`,
      `event_count: ${params.eventCount}\n`,
      `runtime_event_count: ${params.runtimeEventCount}\n`,
      `transcript_event_count: ${params.transcriptEventCount}\n`,
      `included_files: ${files.join(", ")}\n`,
      "selection_note: Explicit forensic mode. Includes every epoch retained under the durable sidebar session.\n",
    ];
    for (const relative of files) {
      chunks.push(`===== BEGIN FILE: ${relative} =====\n`);
      chunks.push(
        relative === "manifest.json"
          ? sourceManifestText
          : await readSafeExportFile(outputDir, relative),
      );
      chunks.push(`\n===== END FILE: ${relative} =====\n`);
    }
    chunks.push("===== END MTRACE EXPORT =====\n");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `mtrace-${params.sessionId.slice(0, 8)}-history-${stamp}.md`;
    const filePath = path.join(outputDir, filename);
    await fs.writeFile(filePath, chunks.join(""), { mode: 0o600, flag: "wx" });
    await fs.chmod(filePath, 0o600);
    const stat = await fs.stat(filePath);
    return {
      filePath,
      filename,
      sizeBytes: stat.size,
      includedFiles: files,
      eventCount: params.eventCount,
      runtimeEventCount: params.runtimeEventCount,
      transcriptEventCount: params.transcriptEventCount,
      scope: "full-session",
    };
  }

  if (sourceManifest.selectionScope !== "current-conversation") {
    throw new Error("Mtrace current export requires a typed current-conversation bundle");
  }
  const rawEvents = await readSafeExportFile(outputDir, "events.jsonl");
  const projection = {
    ...projectRawEvents(rawEvents),
    resetBoundaryAt:
      typeof sourceManifest.resetBoundaryAt === "string"
        ? sourceManifest.resetBoundaryAt
        : undefined,
    resetBoundaryEntryId:
      typeof sourceManifest.resetBoundaryEntryId === "string"
        ? sourceManifest.resetBoundaryEntryId
        : undefined,
    conversationStartedAt:
      typeof sourceManifest.conversationStartedAt === "string"
        ? sourceManifest.conversationStartedAt
        : undefined,
  };
  const virtualFiles = new Map<string, string>();

  const selectedNames: string[] = ["manifest.json"];
  if (
    (params.mode === "full" || params.mode === "prompt-tool-runtime") &&
    available.has("metadata.json")
  ) {
    selectedNames.push("metadata.json");
  }
  if (params.mode === "full") {
    selectedNames.push("current-events.jsonl");
  } else if (params.mode === "transcript") {
    selectedNames.push("current-transcript.jsonl");
  } else {
    selectedNames.push("current-prompt-tool-runtime.jsonl");
  }

  virtualFiles.set("current-events.jsonl", projection.allEvents);
  virtualFiles.set("current-transcript.jsonl", projection.transcriptEvents);
  virtualFiles.set("current-prompt-tool-runtime.jsonl", projection.promptToolRuntimeEvents);

  const mtraceManifest = {
    format: "mtrace/session-export-v3",
    generatedAt: new Date().toISOString(),
    mode: params.mode,
    scope: projection.scope,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    lifecycleRevision: params.lifecycleRevision || undefined,
    resetBoundaryAt: projection.resetBoundaryAt,
    resetBoundaryEntryId: projection.resetBoundaryEntryId,
    conversationStartedAt: projection.conversationStartedAt,
    preResetHistoryExcluded: projection.scope === "since-last-reset",
    eventCount: projection.eventCount,
    runtimeEventCount: projection.runtimeEventCount,
    transcriptEventCount: projection.transcriptEventCount,
    sourceBundle: {
      traceSchema: isRecord(sourceManifest) ? sourceManifest.traceSchema : undefined,
      schemaVersion: isRecord(sourceManifest) ? sourceManifest.schemaVersion : undefined,
      generatedAt: isRecord(sourceManifest) ? sourceManifest.generatedAt : undefined,
      eventCount: params.eventCount,
      runtimeEventCount: params.runtimeEventCount,
      transcriptEventCount: params.transcriptEventCount,
    },
    contents: selectedNames.map((file) => ({ path: file })),
  };
  virtualFiles.set("manifest.json", JSON.stringify(mtraceManifest, null, 2));

  const chunks = [
    "===== BEGIN MTRACE EXPORT =====\n",
    "format: mtrace/session-export-v3\n",
    `mode: ${params.mode}\n`,
    "selection: current-conversation-since-latest-reset\n",
    `scope: ${projection.scope}\n`,
    `session_id: ${params.sessionId}\n`,
    `session_key: ${params.sessionKey}\n`,
    ...(projection.resetBoundaryAt ? [`reset_boundary_at: ${projection.resetBoundaryAt}\n`] : []),
    ...(projection.conversationStartedAt
      ? [`conversation_started_at: ${projection.conversationStartedAt}\n`]
      : []),
    `event_count: ${projection.eventCount}\n`,
    `runtime_event_count: ${projection.runtimeEventCount}\n`,
    `transcript_event_count: ${projection.transcriptEventCount}\n`,
    `included_files: ${selectedNames.join(", ")}\n`,
    "selection_note: The trajectory exporter selected the typed active branch and post-reset runtime evidence before serialization. Raw selected event lines are preserved without reparsing potentially malformed redacted payloads.\n",
  ];

  for (const relative of selectedNames) {
    chunks.push(`===== BEGIN FILE: ${relative} =====\n`);
    const virtual = virtualFiles.get(relative);
    if (virtual !== undefined) {
      chunks.push(virtual);
    } else {
      chunks.push(await readSafeExportFile(outputDir, relative));
    }
    chunks.push(`\n===== END FILE: ${relative} =====\n`);
  }
  chunks.push("===== END MTRACE EXPORT =====\n");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `mtrace-${params.sessionId.slice(0, 8)}-${params.mode}-${stamp}.md`;
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, chunks.join(""), { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600);
  const stat = await fs.stat(filePath);
  return {
    filePath,
    filename,
    sizeBytes: stat.size,
    includedFiles: selectedNames,
    eventCount: projection.eventCount,
    runtimeEventCount: projection.runtimeEventCount,
    transcriptEventCount: projection.transcriptEventCount,
    scope: projection.scope,
    resetBoundaryAt: projection.resetBoundaryAt,
    conversationStartedAt: projection.conversationStartedAt,
  };
}

function resolveExactSession(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  lifecycleRevision?: string;
}): ResolvedMtraceSession {
  if (!UUID_PATTERN.test(params.sessionId)) {
    throw new Error("Session ID must be an exact UUID; refusing to guess an export target");
  }
  const config = getRuntimeConfig();
  const agentIds = listAgentIds(config);
  if (!agentIds.includes(params.agentId)) {
    throw new Error("The requested Mtrace agent is not configured");
  }
  const storePath = resolveSessionStorePathCore(config.session?.store, {
    agentId: params.agentId,
  });
  const entry = loadSessionEntryReadOnly({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath,
  });
  if (!entry?.sessionId || entry.sessionId !== params.sessionId) {
    throw new Error("Current session identity did not match the authoritative session registry");
  }
  const lifecycleRevision =
    typeof entry.lifecycleRevision === "string" && entry.lifecycleRevision.trim()
      ? entry.lifecycleRevision.trim()
      : undefined;
  if (params.lifecycleRevision && lifecycleRevision !== params.lifecycleRevision) {
    throw new Error("Current session generation changed; create a new Mtrace export");
  }

  const matches = agentIds.flatMap((agentId) => {
    const candidateStore = resolveSessionStorePathCore(config.session?.store, { agentId });
    const sessionKey = resolveSessionKeyBySessionId({
      agentId,
      sessionId: params.sessionId,
      storePath: candidateStore,
    });
    return sessionKey ? [{ agentId, sessionKey }] : [];
  });
  if (
    matches.length !== 1 ||
    matches[0]?.agentId !== params.agentId ||
    matches[0]?.sessionKey !== params.sessionKey
  ) {
    throw new Error(
      `Session identity resolved to ${matches.length} canonical targets; refusing to guess`,
    );
  }
  return {
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath,
    entry,
    lifecycleRevision,
  };
}

async function createArtifact(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  lifecycleRevision?: string;
  mode: MtraceExportMode;
}): Promise<{
  artifactId: string;
  artifact: MtraceArtifact;
  counts: Record<string, number>;
}> {
  const before = resolveExactSession(params);
  const config = getRuntimeConfig();
  const target = resolveSessionTranscriptReadTarget({
    agentId: before.agentId,
    sessionEntry: before.entry,
    sessionId: before.sessionId,
    sessionKey: before.sessionKey,
    storePath: before.storePath,
  });
  const summary = await exportTrajectoryForCommand({
    sessionTarget: {
      agentId: target.agentId ?? before.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey ?? before.sessionKey,
      storePath: target.storePath,
    },
    sessionId: before.sessionId,
    sessionKey: before.sessionKey,
    workspaceDir: resolveAgentWorkspaceDir(config, before.agentId),
    conversationScope: params.mode === "history" ? undefined : "current",
  });

  const after = resolveExactSession(params);
  if (
    after.sessionId !== before.sessionId ||
    after.sessionKey !== before.sessionKey ||
    after.agentId !== before.agentId ||
    after.lifecycleRevision !== before.lifecycleRevision
  ) {
    throw new Error("Session generation changed during export; refusing to publish an artifact");
  }

  const markdown = await buildMtraceMarkdown({
    ...summary,
    sessionKey: before.sessionKey,
    lifecycleRevision: before.lifecycleRevision,
    mode: params.mode,
  });
  const artifactId = randomUUID();
  const artifact: MtraceArtifact = {
    agentId: before.agentId,
    expiresAt: Date.now() + MTRACE_ARTIFACT_TTL_MS,
    filePath: markdown.filePath,
    outputDir: path.resolve(summary.outputDir),
    filename: markdown.filename,
    mode: params.mode,
    sessionId: before.sessionId,
    sessionKey: before.sessionKey,
    sizeBytes: markdown.sizeBytes,
    includedFiles: markdown.includedFiles,
    lifecycleRevision: before.lifecycleRevision,
    scope: markdown.scope,
    resetBoundaryAt: markdown.resetBoundaryAt,
    conversationStartedAt: markdown.conversationStartedAt,
  };
  artifacts.set(artifactId, artifact);
  return {
    artifactId,
    artifact,
    counts: {
      eventCount: markdown.eventCount,
      runtimeEventCount: markdown.runtimeEventCount,
      transcriptEventCount: markdown.transcriptEventCount,
    },
  };
}

function artifactPathIsSafe(artifact: MtraceArtifact): boolean {
  return isPathInside(path.resolve(artifact.outputDir), path.resolve(artifact.filePath));
}

export async function handleMtraceHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth?: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  if (
    url.pathname !== `${MTRACE_ROOT}/export` &&
    !url.pathname.startsWith(`${MTRACE_ROOT}/download/`)
  ) {
    return false;
  }
  await purgeExpiredArtifacts();
  const requestAuth = await authorizeControlUiReadRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    requiredOperatorMethod: "sessions.list",
  });
  if (!requestAuth) {
    return true;
  }

  if (url.pathname === `${MTRACE_ROOT}/export`) {
    if (req.method !== "POST") {
      respondNotFound(res);
      return true;
    }
    const body = await readJsonBodyOrError(req, res, MTRACE_REQUEST_MAX_BYTES);
    if (!body || !isRecord(body)) {
      return true;
    }
    const agentId = readString(body, "agentId");
    const sessionId = readString(body, "sessionId");
    const sessionKey = readString(body, "sessionKey");
    const lifecycleRevision = readOptionalString(body, "lifecycleRevision");
    const mode = readMode(body);
    if (!agentId || !sessionId || !sessionKey || !mode) {
      sendJson(res, 400, {
        error: "agentId, sessionId, canonical sessionKey, and a supported export mode are required",
      });
      return true;
    }
    try {
      const { artifactId, artifact, counts } = await createArtifact({
        agentId,
        sessionId,
        sessionKey,
        lifecycleRevision,
        mode,
      });
      sendJson(res, 200, {
        artifactId,
        mode: artifact.mode,
        filename: artifact.filename,
        sizeBytes: artifact.sizeBytes,
        includedFiles: artifact.includedFiles,
        agentId: artifact.agentId,
        sessionId: artifact.sessionId,
        sessionKey: artifact.sessionKey,
        lifecycleRevision: artifact.lifecycleRevision,
        scope: artifact.scope,
        resetBoundaryAt: artifact.resetBoundaryAt,
        conversationStartedAt: artifact.conversationStartedAt,
        expiresAt: new Date(artifact.expiresAt).toISOString(),
        ...counts,
      });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : "Mtrace export failed",
      });
    }
    return true;
  }

  if (!isReadHttpMethod(req.method)) {
    respondNotFound(res);
    return true;
  }
  const artifactId = url.pathname.slice(`${MTRACE_ROOT}/download/`.length);
  const artifact = artifacts.get(artifactId);
  if (!artifact || !UUID_PATTERN.test(artifactId) || !artifactPathIsSafe(artifact)) {
    respondNotFound(res);
    return true;
  }
  try {
    const current = resolveExactSession({
      agentId: artifact.agentId,
      sessionId: artifact.sessionId,
      sessionKey: artifact.sessionKey,
      lifecycleRevision: artifact.lifecycleRevision,
    });
    if (current.lifecycleRevision !== artifact.lifecycleRevision) {
      respondNotFound(res);
      return true;
    }
    const linkStat = await fs.lstat(artifact.filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      respondNotFound(res);
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      buildAssistantMediaContentDisposition(artifact.filename, "text/markdown"),
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", linkStat.size);
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    const data = await fs.readFile(artifact.filePath);
    res.end(data);
    artifacts.delete(artifactId);
    await removeArtifactFile(artifact);
  } catch {
    respondNotFound(res);
  }
  return true;
}
