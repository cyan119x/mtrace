export const identityKey=id=>id?JSON.stringify([id.agentId,id.sessionKey,id.sessionId,id.lifecycleRevision??null]):'';
export function createPanelController({invoke,fetchArtifact,deliver,onChange=()=>{},now=()=>Date.now()}){
 let context=null,epoch=0,refreshSeq=0,disposed=false;
 const state={phase:'idle',identity:null,artifact:null,message:'Choose an export for this conversation.',startedAt:null};
 const publish=()=>{if(!disposed)onChange({...state});};
 const valid=(v)=>!disposed&&v===epoch;
 const busy=()=>['resolving','exporting','downloading'].includes(state.phase);
 const cleanError=e=>String(e?.message||'Export failed. Retry after checking the session.').replace(/([?&]token=)[^\s]+/gi,'$1[redacted]').slice(0,300);
 function contextChanged(next){const changed=!context||context.agentId!==next.agentId||context.sessionKey!==next.sessionKey;context={agentId:next.agentId,sessionKey:next.sessionKey};if(changed){epoch++;Object.assign(state,{phase:'idle',identity:null,artifact:null,startedAt:null,message:'Choose an export for this conversation.'});publish();}return changed;}
 function invalidate(message='Session changed. Create a new export.'){epoch++;Object.assign(state,{phase:'stale',artifact:null,identity:null,startedAt:null,message});publish();}
 async function refresh(){const request=++refreshSeq,v=epoch,c={...context};try{const id=await invoke('status',{},c);if(!valid(v)||request!==refreshSeq)return;if(state.identity&&identityKey(id)!==identityKey(state.identity)){invalidate();state.identity=id;}else state.identity=id;publish();}catch{if(valid(v)&&request===refreshSeq&&!busy()){state.phase='error';state.message='Session identity unavailable. Refresh and try again.';publish();}}}
 async function run(mode){if(disposed||busy())return;refreshSeq++;const v=++epoch,c={...context};Object.assign(state,{phase:'resolving',artifact:null,message:'Checking session identity…',startedAt:now()});publish();try{
  const id=await invoke('status',{},c);if(!valid(v))return;state.identity=id;state.phase='exporting';state.message=mode==='transcript'?'Building transcript…':'Collecting available evidence. This can take a minute…';publish();
  const a=await invoke('export',{mode,expectedSessionId:id.sessionId,expectedLifecycleRevision:id.lifecycleRevision??null},c);if(!valid(v))return;
  if(a.status==='unavailable'){if(!['NO_CURRENT_USER','EMPTY_CONVERSATION'].includes(a.code))throw new Error('Export unavailable. Refresh and try again.');Object.assign(state,{phase:'needs-input',artifact:null,startedAt:null,message:cleanError({message:a.message})});publish();return;}
  const fresh=await invoke('status',{},c);if(!valid(v))return;
  if(identityKey(id)!==identityKey(fresh)||a.sessionId!==id.sessionId||(a.lifecycleRevision??null)!==(id.lifecycleRevision??null))throw new Error('Session changed during export. Create a new export.');
  if(!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<=now())throw new Error('Export has expired. Create a new export.');
  Object.assign(state,{phase:'ready',artifact:a,identity:fresh,startedAt:null,message:'Ready for one download.'});publish();
 }catch(e){if(valid(v)){Object.assign(state,{phase:'error',artifact:null,startedAt:null,message:cleanError(e)});publish();}}}
 async function download(){if(disposed||state.phase!=='ready'||!state.artifact)return;refreshSeq++;tick();if(state.phase!=='ready')return;const v=++epoch,a=state.artifact,id=state.identity,c={...context};state.phase='downloading';state.message='Checking and downloading…';publish();try{
  const fresh=await invoke('status',{},c);if(!valid(v))return;if(identityKey(fresh)!==identityKey(id))throw new Error('Session changed. Create a new export.');
  if(!a.downloadUrl.startsWith('/__openclaw__/plugins/mtrace/download/'))throw new Error('Invalid download route');
  const blob=await fetchArtifact(a);if(!valid(v))return;
  const latest=await invoke('status',{},c);if(!valid(v))return;if(identityKey(latest)!==identityKey(id))throw new Error('Session changed during download. Create a new export.');
  await deliver(blob,a.filename);if(!valid(v))return;state.phase='handed-off';state.artifact=null;state.message='File handed to your browser. Check Downloads. This link has been used.';publish();
 }catch(e){if(valid(v)){state.phase='error';state.artifact=null;state.message=cleanError(e);publish();}}}
 function tick(){if(state.phase==='ready'&&Date.parse(state.artifact?.expiresAt)<=now()){state.phase='expired';state.artifact=null;state.message='Export expired. Create a new export.';publish();}}
 return {state,setContext:contextChanged,refresh,run,download,invalidate,tick,dispose(){disposed=true;epoch++;state.artifact=null;}};
}
