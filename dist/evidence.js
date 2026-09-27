import { activeBranch, isCanonicalSessionTranscriptEntry as canonical } from './transcript-model.js';
import { selectCurrentConversation } from './current-conversation.js';
import { createPrivacyProjector } from './privacy.js';
const MODES=new Set(['full','transcript','prompt-tool-runtime','history']);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function runIds(e){const m=e.message??{};const meta=m.__openclaw??e.__openclaw??{};const key=m.idempotencyKey;const ids=[meta.runId,meta.steerTargetRunId];if(typeof key==='string'){ids.push(key,key.replace(/:user(?::.*)?$/,''));if(key.startsWith('hook-block:before_agent_run:user:'))ids.push(key.slice('hook-block:before_agent_run:user:'.length));}return ids.filter(x=>typeof x==='string'&&x);}
const promptTranscript=e=>e.type==='message'&&(e.message?.role==='user'||e.message?.role==='toolResult'||(Array.isArray(e.message?.content)&&e.message.content.some(b=>b.type==='toolCall')))||e.type==='custom_message';
const textOf=m=>typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(b=>b?.type==='text').map(b=>b.text??'').join('\n'):'';
function fenced(s,language=''){const matches=String(s).match(/`+/g)??[];const fence='`'.repeat(Math.max(3,...matches.map(x=>x.length+1)));return fence+language+'\n'+s+'\n'+fence+'\n';}
export function buildEvidence({allEntries,runtimeRows=[],identity,mode,generatedAt=new Date().toISOString(),snapshotAt=generatedAt}){
 if(!MODES.has(mode))throw new Error('Unknown MTrace mode');
 if(!identity?.agentId||!identity.sessionId||!identity.sessionKey)throw new Error('Missing evidence identity');
 const cutoff=Date.parse(snapshotAt);if(!Number.isFinite(cutoff))throw new Error('Invalid snapshot timestamp');
 if(!Array.isArray(allEntries)||allEntries.length>100000)throw new Error('Transcript source exceeds bounded export capacity');
 if(allEntries.some(e=>!record(e)||(canonical(e)||e.type==='leaf')&&!e.id))throw new Error('Transcript structure is incomplete; refusing export');
 if(allEntries.some(e=>(canonical(e)||e.type==='leaf')&&!Number.isFinite(Date.parse(e.timestamp))))throw new Error('Transcript source contains an invalid timestamp');
 const entries=allEntries.filter(e=>!e?.timestamp||Date.parse(e.timestamp)<=cutoff);
 const branch=activeBranch(entries);
 if(!Array.isArray(runtimeRows)||runtimeRows.some(r=>!record(r)||r.source!=='runtime'||!Number.isFinite(Date.parse(r.ts))||r.sessionId!==identity.sessionId))throw new Error('Runtime evidence identity or envelope is invalid');
 const eligibleRuntime=runtimeRows.filter(r=>Date.parse(r.ts)<=cutoff);
 let selected,chosen,runtime;
 if(mode==='history'){
  chosen=entries.filter(canonical);runtime=eligibleRuntime;
  selected={selectedEntries:chosen,resetBoundaryAt:null,resetBoundaryEntryId:null,conversationStartedAt:chosen[0]?.timestamp??null};
 }else{
  selected=selectCurrentConversation({branchEntries:branch,allEntries:entries,runtimeEvents:mode==='transcript'?[]:eligibleRuntime});
  chosen=selected.selectedEntries;
  if(!chosen.length)throw new Error('No conversation entries available');
  const start=Date.parse(selected.conversationStartedAt);
  const selectedRuns=new Set(selected.selectedRunIds);
  const lastReset=branch.findLastIndex(e=>e.type==='reset');
  if(lastReset>=0 && branch.slice(0,lastReset).some(e=>e.type==='message'&&e.message?.role==='user'&&runIds(e).some(r=>selectedRuns.has(r))))throw new Error('A selected run crosses the reset boundary; refusing ambiguous runtime evidence');
  runtime=mode==='transcript'?[]:eligibleRuntime.filter(r=>selectedRuns.has(r.runId)&&Date.parse(r.ts)>=start);
 }
 if(mode==='prompt-tool-runtime')chosen=chosen.filter(promptTranscript);
 const privacy=createPrivacyProjector();
 const transcriptEvents=chosen.map((entry,i)=>({source:'transcript',type:entry.type==='message'?String(entry.message?.role??'unknown')+'.message':'session.'+entry.type,ts:entry.timestamp,entryId:entry.id,seq:i,sessionId:identity.sessionId,data:{entry:privacy.project(entry)}}));
 const safeRuntime=runtime.map(r=>privacy.project(r));
 const events=[...transcriptEvents,...safeRuntime].sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts)||(a.source===b.source?(a.seq??0)-(b.seq??0):a.source==='transcript'?-1:1));
 const coverageWarnings=[];
 if(mode!=='transcript')coverageWarnings.push('Runtime capture is diagnostic and may omit or truncate prompt/tool payloads. Complete historical runtime capture is not asserted.');
 if(!runtime.length&&mode!=='transcript')coverageWarnings.push('No retained runtime events were available for the selected scope.');
 if(privacy.stats.sourceLossMarkers)coverageWarnings.push('Source content contains existing truncation/redaction markers; these were not reconstructed.');
 if(privacy.stats.redactedFields||privacy.stats.redactedStrings)coverageWarnings.push('Credentials, inline media bytes and private replay/reasoning material are protected by the export privacy policy.');
 const coverageStatus=mode==='transcript'&&!privacy.stats.sourceLossMarkers?'complete':'partial';
 const scope=mode==='history'?'full-session':'since-last-reset';
 const allChosen=selected.selectedEntries;
 const conversationEndedAt=allChosen.at(-1)?.timestamp??null;
 const result={mode,scope,eventCount:events.length,runtimeEventCount:safeRuntime.length,transcriptEventCount:transcriptEvents.length,resetBoundaryAt:selected.resetBoundaryAt??null,resetBoundaryEntryId:selected.resetBoundaryEntryId??null,conversationStartedAt:selected.conversationStartedAt??null,conversationEndedAt,coverageStatus,coverageWarnings};
 const manifest={format:'mtrace/feature-plugin-v2',generatedAt,snapshotAt,...identity,...result,selection:mode==='history'?'all-retained-session-history':'authoritative-active-conversation',preResetHistoryExcluded:mode==='history'?false:true,structuralSource:'public-session-transcript-runtime',rawRuntimeCompleteness:'not-asserted',privacyPolicy:'mtrace-record-redaction-v1',privacy:privacy.stats};
 const parts=['# MTrace session evidence\n','Mode: '+mode+'\nScope: '+scope+'\n','Conversation: '+(result.conversationStartedAt??'none')+' to '+(conversationEndedAt??'none')+'\n','Coverage: '+coverageStatus+' (complete means retained transcript entries, with privacy redaction)\n',...coverageWarnings.map(w=>'- '+w+'\n'),'\n## Manifest\n',fenced(JSON.stringify(manifest,null,2),'json')];
 if(mode!=='prompt-tool-runtime'){
  parts.push('\n## Readable conversation\n');
  for(const e of transcriptEvents){const m=e.data.entry.message;if(m&&['user','assistant'].includes(m.role)){const text=textOf(m);if(text)parts.push('\n### '+m.role+' · '+e.ts+'\n',fenced(text));}}
 }
 parts.push('\n## Evidence events (JSONL)\n',fenced(events.map(e=>JSON.stringify(e)).join('\n'),'jsonl'),'\n<!-- MTRACE EXPORT COMPLETE -->\n');
 const text=parts.join('');if(Buffer.byteLength(text,'utf8')>64*1024*1024)throw new Error('Evidence exceeds 64 MiB; no truncated artifact was published');
 return {...result,text,manifest,events};
}
