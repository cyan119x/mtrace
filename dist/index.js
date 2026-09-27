import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { contract } from './contract.js';
import { createArtifact,getIdentity,inspectArtifact,takeArtifact } from './export-service.js';
import { createDownloadHandler,DOWNLOAD_ROOT } from './download-http.js';
function target(ctx){const agentId=ctx.action?.agentId?.trim(),sessionKey=ctx.action?.sessionKey?.trim();if(!agentId||!sessionKey)throw new Error('MTrace requires a concrete Control UI session');return {agentId,sessionKey};}
export default defineFeaturePlugin({contract,name:'MTrace',description:'Reset-aware session evidence with honest coverage.',setup(api){
 api.registerHttpRoute({path:DOWNLOAD_ROOT.slice(0,-1),auth:'plugin',match:'prefix',handler:createDownloadHandler({inspect:inspectArtifact,take:takeArtifact})});
 return {status(_input,ctx){const p=target(ctx);return getIdentity(p.agentId,p.sessionKey);},async export(input,ctx){
  const a=await createArtifact({...input,...target(ctx)});
  const result={downloadUrl:DOWNLOAD_ROOT+a.artifactId+'?token='+encodeURIComponent(a.downloadToken),expiresAt:new Date(a.expiresAt).toISOString()};
  for(const k of ['artifactId','mode','filename','sizeBytes','sessionId','lifecycleRevision','scope','eventCount','runtimeEventCount','transcriptEventCount','resetBoundaryAt','resetBoundaryEntryId','conversationStartedAt','conversationEndedAt','coverageStatus','coverageWarnings'])result[k]=a[k]??null;
  return result;
 }};
}});
