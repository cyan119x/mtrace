import crypto from 'node:crypto';
import { createDownloadCapability, verifyDownloadTokenHash } from './download-capability.js';
export const sameGeneration=(a,b)=>a.agentId===b.agentId&&a.sessionKey===b.sessionKey&&a.sessionId===b.sessionId&&(a.lifecycleRevision??null)===(b.lifecycleRevision??null);
export function createExportService({getIdentity,readTranscript,readRuntime,buildEvidence,now=()=>Date.now(),ttlMs=1800000,maxBytes=134217728,maxArtifacts=4,maxParallel=2}){
 const artifacts=new Map(),busy=new Set();let usedBytes=0;
 function remove(id){const a=artifacts.get(id);if(a){usedBytes-=a.sizeBytes;artifacts.delete(id);}}
 function purge(){for(const [id,a]of artifacts)if(a.expiresAt<=now())remove(id);}
 function assertExpected(id,p){if(p.expectedSessionId!==undefined&&id.sessionId!==p.expectedSessionId||Object.hasOwn(p,'expectedLifecycleRevision')&&(id.lifecycleRevision??null)!==p.expectedLifecycleRevision)throw new Error('Session was reset or changed. Refresh identity and try again.');}
 function resolve(id,token,consume=false){purge();const a=artifacts.get(id);if(!a||!verifyDownloadTokenHash(token,a.downloadTokenHash))return undefined;let current;try{current=getIdentity(a.agentId,a.sessionKey);}catch{remove(id);return undefined;}if(!sameGeneration(a,current)){remove(id);return undefined;}if(consume)remove(id);return a;}
 return {
  status:getIdentity, purge,inspect:(id,t)=>resolve(id,t),take:(id,t)=>resolve(id,t,true),
  statistics:()=>({artifacts:artifacts.size,usedBytes,busy:busy.size}),
  async create(params){
   if(!['full','transcript','prompt-tool-runtime','history'].includes(params.mode))throw new Error('Unknown export mode');
   const before=getIdentity(params.agentId,params.sessionKey);assertExpected(before,params);
   const key=before.agentId+'\0'+before.sessionKey;
   if(busy.has(key))throw new Error('An export is already running for this session. Wait for it to finish.');
   if(busy.size>=maxParallel)throw new Error('MTrace export capacity is busy. Try again shortly.');
   busy.add(key);
   try{
    const allEntries=await readTranscript(before);const snapshotAt=new Date(now()).toISOString();
    if(!sameGeneration(before,getIdentity(before.agentId,before.sessionKey)))throw new Error('Session changed while reading transcript. No artifact was published.');
    const runtimeRows=params.mode==='transcript'?[]:await readRuntime(before);
    const result=buildEvidence({allEntries,runtimeRows,identity:before,mode:params.mode,snapshotAt,generatedAt:new Date(now()).toISOString()});
    if(!sameGeneration(before,getIdentity(before.agentId,before.sessionKey)))throw new Error('Session changed during export. No artifact was published.');
    const sizeBytes=Buffer.byteLength(result.text,'utf8');if(sizeBytes>maxBytes)throw new Error('Export is larger than available artifact capacity');
    purge();while(artifacts.size>=maxArtifacts||usedBytes+sizeBytes>maxBytes)remove(artifacts.keys().next().value);
    const artifactId=crypto.randomUUID(),cap=createDownloadCapability();const expiresAt=now()+ttlMs;
    const a={...result,...before,artifactId,downloadTokenHash:cap.tokenHash,filename:'mtrace-'+before.sessionId.slice(0,8)+'-'+params.mode+'-'+new Date(now()).toISOString().replace(/[:.]/g,'-')+'.md',sizeBytes,expiresAt};
    // Keep only the delivery body and metadata, not duplicate raw event objects.
    delete a.events;delete a.manifest;
    artifacts.set(artifactId,a);usedBytes+=sizeBytes;
    return {...a,downloadToken:cap.token};
   }finally{busy.delete(key);}
  }
 };
}
