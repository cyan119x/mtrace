import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { selectCurrentConversation } from "./current-conversation.js";

const TTL_MS = 30 * 60_000;
const artifacts = new Map();
const ROOT = path.join(os.tmpdir(), "openclaw-mtrace-plugin");
function isRecord(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function str(v) { return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function isInside(parent, child) { const rel = path.relative(parent, child); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); }
function jsonLineEnvelope(line) {
  const dataIndex = line.indexOf(',"data":');
  const prefix = line.slice(0, dataIndex >= 0 ? dataIndex : Math.min(line.length, 8192));
  return {
    source: /"source":"(runtime|transcript)"/u.exec(prefix)?.[1],
    type: /"type":"([^"\\]+)"/u.exec(prefix)?.[1],
    ts: /"ts":"([^"\\]+)"/u.exec(prefix)?.[1],
    runId: /"runId":"([^"\\]+)"/u.exec(prefix)?.[1],
    entryId: /"entryId":"([^"\\]+)"/u.exec(prefix)?.[1]
  };
}
function promptRuntimeEvent(e) { return e.source === "runtime" || (e.source === "transcript" && ["tool.call","tool.result","user.message","session.custom_message"].includes(e.type)); }
async function safeRead(dir, rel) {
  if (!rel || path.isAbsolute(rel)) throw new Error(`Unsafe export file: ${rel}`);
  const base = path.resolve(dir); const file = path.resolve(base, rel);
  if (!isInside(base, file)) throw new Error(`Export file escapes bundle: ${rel}`);
  const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Unsafe export file: ${rel}`);
  const [rb, rf] = await Promise.all([fs.realpath(base), fs.realpath(file)]); if (!isInside(rb, rf)) throw new Error(`Export file escapes real bundle: ${rel}`);
  return fs.readFile(rf, "utf8");
}
function identity(agentId, sessionKey) {
  if (!agentId || !sessionKey) throw new Error("MTrace requires the current agentId and canonical sessionKey");
  const entry = getSessionEntry({ agentId, sessionKey });
  if (!entry?.sessionId) throw new Error("Current session is no longer present in the authoritative session store");
  return { agentId, sessionKey, sessionId: entry.sessionId, lifecycleRevision: str(entry.lifecycleRevision) };
}
function sameGeneration(a,b) { return a.agentId===b.agentId && a.sessionKey===b.sessionKey && a.sessionId===b.sessionId && a.lifecycleRevision===b.lifecycleRevision; }
async function runCliExport(id) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mtrace-cli-workspace-"));
  const output = `mtrace-${crypto.randomUUID()}`;
  const request = Buffer.from(JSON.stringify({ sessionKey:id.sessionKey, agent:id.agentId, workspace, output }), "utf8").toString("base64url");
  const bin = process.env.OPENCLAW_BIN?.trim() || "openclaw";
  const result = await runCommandWithTimeout([bin, "sessions", "export-trajectory", "--request-json-base64", request, "--json"], { timeoutMs: 120000, cwd: workspace, env: process.env });
  if (result.code !== 0) { await fs.rm(workspace,{recursive:true,force:true}); throw new Error(`OpenClaw trajectory export failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`); }
  let summary; try { summary = JSON.parse(result.stdout); } catch { await fs.rm(workspace,{recursive:true,force:true}); throw new Error("OpenClaw trajectory exporter returned invalid JSON"); }
  const outputDir = path.resolve(summary.outputDir || path.join(workspace, ".openclaw", "trajectory-exports", output));
  if (!isInside(path.resolve(workspace), outputDir)) { await fs.rm(workspace,{recursive:true,force:true}); throw new Error("Trajectory exporter returned an unsafe output path"); }
  return { workspace, outputDir, summary };
}
async function currentProjection(id, bundle) {
  const branch = JSON.parse(await safeRead(bundle.outputDir, "session-branch.json"));
  if (!isRecord(branch) || !Array.isArray(branch.entries)) throw new Error("Trajectory bundle did not contain an active session branch");
  const allEntries = await readSessionTranscriptEvents({ agentId:id.agentId, sessionId:id.sessionId, sessionKey:id.sessionKey });
  const raw = await safeRead(bundle.outputDir, "events.jsonl");
  const rows = raw.split(/\r?\n/u).filter(Boolean).map((line) => ({ line, ...jsonLineEnvelope(line) }));
  const runtime = rows.filter((r) => r.source === "runtime").map((r) => ({ ts:r.ts, runId:r.runId, line:r.line }));
  if (runtime.some((r) => !r.ts)) throw new Error("Trajectory runtime evidence is missing timestamps");
  const selected = selectCurrentConversation({ branchEntries:branch.entries, allEntries, runtimeEvents:runtime });
  const selectedEntryIds = new Set(selected.selectedEntries.map((e) => str(e?.id)).filter(Boolean));
  const selectedRunIds = new Set(selected.selectedRunIds);
  const selectedRows = rows.filter((r) => r.source === "transcript" ? (r.entryId && selectedEntryIds.has(r.entryId)) : (r.source === "runtime" && r.runId && selectedRunIds.has(r.runId)));
  const transcriptRows = selectedRows.filter((r) => r.source === "transcript");
  const promptRows = selectedRows.filter(promptRuntimeEvent);
  return { selected, selectedRows, transcriptRows, promptRows };
}
function linesText(rows) { return rows.map((r)=>r.line).join("\n") + (rows.length ? "\n" : ""); }
async function historyMarkdown(id, bundle) {
  const manifestText = await safeRead(bundle.outputDir,"manifest.json"); const manifest = JSON.parse(manifestText);
  const listed = Array.isArray(manifest.contents) ? manifest.contents.map((x)=>isRecord(x)&&str(x.path)).filter(Boolean) : (bundle.summary.files || []);
  const files = ["manifest.json", ...listed.filter((x)=>x!=="manifest.json")]; const chunks=["===== BEGIN MTRACE EXPORT =====\n","format: mtrace/feature-plugin-v1\n","mode: history\n","selection: full-sidebar-session-history\n","scope: full-session\n",`session_id: ${id.sessionId}\n`,`session_key: ${id.sessionKey}\n`,`included_files: ${files.join(", ")}\n`];
  for (const f of files) { chunks.push(`===== BEGIN FILE: ${f} =====\n`, f==="manifest.json"?manifestText:await safeRead(bundle.outputDir,f), `\n===== END FILE: ${f} =====\n`); }
  chunks.push("===== END MTRACE EXPORT =====\n"); return { text:chunks.join(""), files, eventCount:manifest.eventCount||0, runtimeEventCount:manifest.runtimeEventCount||0, transcriptEventCount:manifest.transcriptEventCount||0, scope:"full-session" };
}
async function currentMarkdown(id, bundle, mode) {
  const p = await currentProjection(id,bundle);
  const rows = mode === "full" ? p.selectedRows : mode === "transcript" ? p.transcriptRows : p.promptRows;
  const eventName = mode === "full" ? "current-events.jsonl" : mode === "transcript" ? "current-transcript.jsonl" : "current-prompt-tool-runtime.jsonl";
  const manifest = { format:"mtrace/feature-plugin-v1", generatedAt:new Date().toISOString(), mode, scope:"since-last-reset", sessionId:id.sessionId, sessionKey:id.sessionKey, lifecycleRevision:id.lifecycleRevision, resetBoundaryAt:p.selected.resetBoundaryAt, resetBoundaryEntryId:p.selected.resetBoundaryEntryId, conversationStartedAt:p.selected.conversationStartedAt, preResetHistoryExcluded:true, runtimeCorrelation:"selected-user-anchored-run-id", sharedTranscriptRunCount:p.selected.sharedRunIds?.length || 0, selectedRunCount:p.selected.selectedRunIds.length, eventCount:p.selectedRows.length, runtimeEventCount:p.selectedRows.filter((r)=>r.source==="runtime").length, transcriptEventCount:p.transcriptRows.length, contents:[{path:"manifest.json"},{path:"session-branch.json"},{path:eventName}] };
  const branch = JSON.stringify({ entries:p.selected.selectedEntries }, null, 2);
  const files=["manifest.json","session-branch.json",eventName]; const virtual={"manifest.json":JSON.stringify(manifest,null,2),"session-branch.json":branch,[eventName]:linesText(rows)};
  const chunks=["===== BEGIN MTRACE EXPORT =====\n","format: mtrace/feature-plugin-v1\n",`mode: ${mode}\n`,`selection: current-conversation-since-latest-reset\n`,`scope: since-last-reset\n`,`session_id: ${id.sessionId}\n`,`session_key: ${id.sessionKey}\n`,...(p.selected.resetBoundaryAt?[`reset_boundary_at: ${p.selected.resetBoundaryAt}\n`]:[]),...(p.selected.conversationStartedAt?[`conversation_started_at: ${p.selected.conversationStartedAt}\n`]:[]),`event_count: ${manifest.eventCount}\n`,`runtime_event_count: ${manifest.runtimeEventCount}\n`,`transcript_event_count: ${manifest.transcriptEventCount}\n`,`included_files: ${files.join(", ")}\n`,`selection_note: MTrace used the public session transcript runtime plus the official OpenClaw trajectory exporter. Runtime events are selected by run ownership; a run shared with off-branch transcript rows is accepted only when the selected branch contains a user anchor for that run. Off-branch transcript rows remain excluded by entry id. Selected raw event lines are preserved.\n`];
  for (const f of files) chunks.push(`===== BEGIN FILE: ${f} =====\n`,virtual[f],`\n===== END FILE: ${f} =====\n`); chunks.push("===== END MTRACE EXPORT =====\n");
  return { text:chunks.join(""), files, eventCount:manifest.eventCount, runtimeEventCount:manifest.runtimeEventCount, transcriptEventCount:manifest.transcriptEventCount, scope:"since-last-reset", resetBoundaryAt:p.selected.resetBoundaryAt, conversationStartedAt:p.selected.conversationStartedAt };
}
export async function purgeExpiredArtifacts(now=Date.now()) { await fs.mkdir(ROOT,{recursive:true,mode:0o700}); for (const [key,a] of artifacts) if (a.expiresAt<=now) { artifacts.delete(key); await fs.rm(a.filePath,{force:true}); } }
export async function createArtifact({agentId,sessionKey,mode}) {
  await purgeExpiredArtifacts(); const before=identity(agentId,sessionKey); const bundle=await runCliExport(before);
  try {
    const built = mode === "history" ? await historyMarkdown(before,bundle) : await currentMarkdown(before,bundle,mode);
    const after=identity(agentId,sessionKey); if (!sameGeneration(before,after)) throw new Error("Session generation changed during export; refusing to publish an artifact");
    const artifactId=crypto.randomUUID(); const stamp=new Date().toISOString().replace(/[:.]/gu,"-"); const filename=`mtrace-${before.sessionId.slice(0,8)}-${mode}-${stamp}.md`; const filePath=path.join(ROOT,`${artifactId}.md`); await fs.writeFile(filePath,built.text,{mode:0o600,flag:"wx"}); const st=await fs.stat(filePath);
    const artifact={ artifactId, agentId, sessionKey, sessionId:before.sessionId, lifecycleRevision:before.lifecycleRevision, mode, filename, filePath, sizeBytes:st.size, expiresAt:Date.now()+TTL_MS, ...built }; artifacts.set(artifactId,artifact); return artifact;
  } finally { await fs.rm(bundle.workspace,{recursive:true,force:true}); }
}
export function getIdentity(agentId,sessionKey) { return identity(agentId,sessionKey); }
export async function takeArtifact(id) { await purgeExpiredArtifacts(); const a=artifacts.get(id); if (!a) return undefined; const now=identity(a.agentId,a.sessionKey); if (!sameGeneration(a,now)) { artifacts.delete(id); await fs.rm(a.filePath,{force:true}); return undefined; } artifacts.delete(id); return a; }
export async function discardArtifact(a) { await fs.rm(a.filePath,{force:true}); }
