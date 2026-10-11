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

export type MtraceExportMode = "full" | "transcript" | "prompt-tool-runtime";

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
  return value === "full" || value === "transcript" || value === "prompt-tool-runtime"
    ? value
    : undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function selectionForMode(
  mode: MtraceExportMode,
  exportedFiles: string[],
): {
  files: string[];
  selection: string;
  note?: string;
} {
  const available = new Set(["manifest.json", ...exportedFiles]);
  const select = (candidates: string[]) => candidates.filter((file) => available.has(file));
  if (mode === "transcript") {
    return {
      files: select(["manifest.json", "session-branch.json"]),
      selection: "current-raw-transcript-branch",
    };
  }
  if (mode === "prompt-tool-runtime") {
    return {
      files: select([
        "manifest.json",
        "metadata.json",
        "artifacts.json",
        "prompts.json",
        "system-prompt.txt",
        "tools.json",
        "events.jsonl",
      ]),
      selection: "prompt-tool-runtime-with-exact-mixed-raw-event-stream",
      note: "events.jsonl is included byte-for-byte because runtime and transcript events share one raw stream and some redacted runtime lines may not be parseable JSON; Mtrace does not rewrite or silently drop them.",
    };
  }
  return {
    files: [...available],
    selection: "full-session",
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
  mode: MtraceExportMode;
  eventCount: number;
  runtimeEventCount: number;
  transcriptEventCount: number;
  files: string[];
}): Promise<{ filePath: string; filename: string; sizeBytes: number; includedFiles: string[] }> {
  const outputDir = path.resolve(params.outputDir);
  const manifestText = await readSafeExportFile(outputDir, "manifest.json");
  const manifest = JSON.parse(manifestText) as unknown;
  if (
    !isRecord(manifest) ||
    manifest.sessionId !== params.sessionId ||
    manifest.sessionKey !== params.sessionKey
  ) {
    throw new Error("Mtrace export manifest identity did not match the requested session");
  }
  // The command summary historically inferred prompt/tool filenames from runtime
  // event types. Those files are deliberately omitted when the runtime capture
  // has no exact prompt or tool payload, so use the manifest's actual inventory
  // as the source of truth rather than attempting to read a phantom file.
  const manifestFiles = Array.isArray(manifest.contents)
    ? manifest.contents.flatMap((entry) =>
        isRecord(entry) && typeof entry.path === "string" ? [entry.path] : [],
      )
    : params.files;
  const selected = selectionForMode(params.mode, manifestFiles);
  if (!selected.files.includes("manifest.json")) {
    throw new Error("Mtrace export did not produce a manifest");
  }
  if (params.mode === "transcript" && !selected.files.includes("session-branch.json")) {
    throw new Error("Mtrace transcript export did not produce session-branch.json");
  }
  if (
    params.mode === "prompt-tool-runtime" &&
    (!selected.files.includes("prompts.json") || !selected.files.includes("events.jsonl"))
  ) {
    throw new Error("Mtrace prompt/tool/runtime export is missing required raw evidence");
  }

  const chunks = [
    "===== BEGIN MTRACE EXPORT =====\n",
    "format: mtrace/session-export-v2\n",
    `mode: ${params.mode}\n`,
    `selection: ${selected.selection}\n`,
    `session_id: ${params.sessionId}\n`,
    `session_key: ${params.sessionKey}\n`,
    `event_count: ${params.eventCount}\n`,
    `runtime_event_count: ${params.runtimeEventCount}\n`,
    `transcript_event_count: ${params.transcriptEventCount}\n`,
    `included_files: ${selected.files.join(", ")}\n`,
    ...(selected.note ? [`selection_note: ${selected.note}\n`] : []),
  ];
  for (const relative of selected.files) {
    chunks.push(`===== BEGIN FILE: ${relative} =====\n`);
    chunks.push(
      relative === "manifest.json" ? manifestText : await readSafeExportFile(outputDir, relative),
    );
    chunks.push(`\n===== END FILE: ${relative} =====\n`);
  }
  chunks.push("===== END MTRACE EXPORT =====\n");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `mtrace-${params.sessionId.slice(0, 8)}-${params.mode}-${stamp}.md`;
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, chunks.join(""), { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600);
  const stat = await fs.stat(filePath);
  return { filePath, filename, sizeBytes: stat.size, includedFiles: selected.files };
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
  };
  artifacts.set(artifactId, artifact);
  return {
    artifactId,
    artifact,
    counts: {
      eventCount: summary.eventCount,
      runtimeEventCount: summary.runtimeEventCount,
      transcriptEventCount: summary.transcriptEventCount,
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
