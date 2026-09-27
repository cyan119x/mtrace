import fs from "node:fs";
import path from "node:path";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";
import { createArtifact, discardArtifact, getIdentity, inspectArtifact, purgeExpiredArtifacts, takeArtifact } from "./export-service.js";

const DOWNLOAD_ROOT = "/__openclaw__/plugins/mtrace/download/";
function agentAndSession(ctx) {
  const agentId = ctx.action?.agentId?.trim();
  const sessionKey = ctx.action?.sessionKey?.trim();
  if (!agentId || !sessionKey) throw new Error("MTrace action must originate from a concrete Control UI session");
  return { agentId, sessionKey };
}

async function sendArtifact(req, res, artifact) {
  try {
    const st = await fs.promises.lstat(artifact.filePath);
    if (!st.isFile() || st.isSymbolicLink()) { res.statusCode=404; res.end(); return true; }
    res.statusCode=200;
    res.setHeader("Content-Type","text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(artifact.filename))}`);
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Pragma","no-cache");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Content-Length",String(st.size));
    if (req.method === "HEAD") { res.end(); return true; }
    await new Promise((resolve,reject)=>{ const stream=fs.createReadStream(artifact.filePath); stream.on("error",reject); res.on("finish",resolve); res.on("close",resolve); stream.pipe(res); });
    return true;
  } finally {
    if (req.method !== "HEAD") await discardArtifact(artifact);
  }
}

export default defineFeaturePlugin({
  contract,
  name: "MTrace",
  description: "Export current conversation evidence or full sidebar-session history without modifying OpenClaw core.",
  setup(api) {
    // Browser-native plugin panels do not receive the Gateway bearer token, and the
    // Control UI's ambient plugin cookie is scoped to native plugin assets/tab paths.
    // This route therefore uses a short-lived, one-time capability token returned only
    // by the authenticated session action. The token is hashed in memory and the
    // artifact remains generation-fenced before every read.
    api.registerHttpRoute({
      path: DOWNLOAD_ROOT.slice(0,-1), auth: "plugin", match: "prefix",
      async handler(req,res) {
        await purgeExpiredArtifacts();
        const url = new URL(req.url || "/", "http://localhost");
        if (!url.pathname.startsWith(DOWNLOAD_ROOT) || (req.method !== "GET" && req.method !== "HEAD")) return false;
        const artifactId = url.pathname.slice(DOWNLOAD_ROOT.length);
        const token = url.searchParams.get("token") || "";
        if (!/^[0-9a-f-]{36}$/iu.test(artifactId)) { res.statusCode=404; res.end(); return true; }
        const artifact = req.method === "HEAD" ? await inspectArtifact(artifactId, token) : await takeArtifact(artifactId, token);
        if (!artifact) { res.statusCode=404; res.setHeader("Cache-Control","no-store"); res.end(); return true; }
        return sendArtifact(req,res,artifact);
      }
    });
    return {
      status(_input,ctx) { const {agentId,sessionKey}=agentAndSession(ctx); const id=getIdentity(agentId,sessionKey); return { ...id, lifecycleRevision:id.lifecycleRevision ?? null }; },
      async export({mode},ctx) {
        const {agentId,sessionKey}=agentAndSession(ctx);
        const a=await createArtifact({agentId,sessionKey,mode});
        return {
          artifactId:a.artifactId,
          mode:a.mode,
          filename:a.filename,
          sizeBytes:a.sizeBytes,
          downloadUrl:`${DOWNLOAD_ROOT}${a.artifactId}?token=${encodeURIComponent(a.downloadToken)}`,
          expiresAt:new Date(a.expiresAt).toISOString(),
          scope:a.scope,
          eventCount:a.eventCount,
          runtimeEventCount:a.runtimeEventCount,
          transcriptEventCount:a.transcriptEventCount,
          resetBoundaryAt:a.resetBoundaryAt ?? null,
          conversationStartedAt:a.conversationStartedAt ?? null
        };
      }
    };
  }
});
