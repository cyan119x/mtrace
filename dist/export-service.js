import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { readSessionTranscriptEvents } from 'openclaw/plugin-sdk/session-transcript-runtime';
import { createExportService } from './artifact-service.js';
import { buildEvidence } from './evidence.js';
import { readRuntimeViaCli } from './runtime-adapter.js';
export function getIdentity(agentId,sessionKey){
 if(!agentId||!sessionKey)throw new Error('A concrete session is required');
 const entry=getSessionEntry({agentId,sessionKey});if(!entry?.sessionId)throw new Error('Session is no longer available');
 return {agentId,sessionKey,sessionId:entry.sessionId,lifecycleRevision:entry.lifecycleRevision??null};
}
const service=createExportService({getIdentity,readTranscript:id=>readSessionTranscriptEvents(id),readRuntime:readRuntimeViaCli,buildEvidence});
export const createArtifact=p=>service.create(p);
export const inspectArtifact=(id,t)=>service.inspect(id,t);
export const takeArtifact=(id,t)=>service.take(id,t);
export const purgeExpiredArtifacts=()=>service.purge();
