import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from '../dist/contract.js';
import { createPanelController } from './panel-state.js';
import './control-ui.css';
const MODES=[['transcript','Transcript','Conversation and retained tool records, since the latest reset.'],['full','Full evidence','Transcript plus available runtime evidence. Source limits are reported.'],['prompt-tool-runtime','Prompt + tool/runtime','Available prompts, user inputs and tool/runtime records.'],['history','Full sidebar-session history','All retained session records, including earlier reset epochs.']];
const bytes=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(1)+' MiB';
const date=s=>s?new Date(s).toLocaleString(): 'Not applicable';
export default defineControlUiPlugin({id:'mtrace',activate(host){return host.ui.registerPanel({id:'mtrace',label:'MTrace',mount(container,initial){
 const doc=container.ownerDocument;let context=initial,disposed=false,lastState={},scheduled=null;
 const node=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
 const root=node('section','mtrace-plugin');const heading=node('h2','','Session evidence');
 const lead=node('p','mtrace-lead','Current exports start after the latest reset. History is a separate scope.');
 const identity=node('div','mtrace-identity');const identityValue=node('span','','Resolving session…');const refresh=node('button','mtrace-refresh','Refresh');refresh.type='button';identity.append(identityValue,refresh);
 const actions=node('div','mtrace-actions');const buttons=[];
 const status=node('output','mtrace-status');status.setAttribute('aria-live','polite');const elapsed=node('span','mtrace-elapsed');
 const details=node('div','mtrace-result');details.hidden=true;const summary=node('p','mtrace-summary');const boundary=node('p','mtrace-boundary');const counts=node('p','mtrace-counts');const warnings=node('ul','mtrace-warnings');
 const download=node('button','mtrace-download','Download once');download.type='button';details.append(summary,boundary,counts,warnings,download);
 const controller=createPanelController({invoke:(op,input,target)=>feature.invoke(op,input,target),onChange:render,
  async fetchArtifact(a){const response=await fetch(a.downloadUrl,{credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'});if(!response.ok)throw new Error('Download unavailable, expired or already used. Create a new export.');if(!response.headers.get('content-type')?.includes('text/markdown'))throw new Error('Download returned an unexpected response. Create a new export.');const blob=await response.blob();if(blob.size!==a.sizeBytes)throw new Error('Incomplete download. Create a new export.');return blob;},
  async deliver(blob,filename){const url=URL.createObjectURL(blob);const link=doc.createElement('a');link.href=url;link.download=filename;link.hidden=true;root.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
 });
 const feature=createFeatureClient(contract,host);
 function render(s){lastState=s;const busy=['resolving','exporting','downloading'].includes(s.phase);root.setAttribute('aria-busy',String(busy));for(const b of buttons)b.disabled=busy;refresh.disabled=busy;status.textContent=s.message;status.dataset.phase=s.phase;
  const idText=s.identity?'Session '+s.identity.sessionId:'Session identity pending';if(identityValue.textContent!==idText)identityValue.textContent=idText;identityValue.title=s.identity?.sessionKey??context.props.sessionKey;
  details.hidden=!s.artifact;download.disabled=s.phase!=='ready';download.textContent=s.phase==='downloading'?'Downloading…':'Download once';
  if(s.artifact){const a=s.artifact;summary.textContent=a.filename+' ('+bytes(a.sizeBytes)+')';boundary.textContent=(a.scope==='full-session'?'All retained history':'Current conversation')+'\nReset: '+date(a.resetBoundaryAt)+'\nFirst record: '+date(a.conversationStartedAt)+'\nLast record: '+date(a.conversationEndedAt);counts.textContent=a.eventCount+' events: '+a.transcriptEventCount+' transcript + '+a.runtimeEventCount+' runtime. '+(a.coverageStatus==='partial'?'Source coverage is partial.':'Retained transcript exported with privacy redaction.');warnings.replaceChildren(...a.coverageWarnings.map(w=>node('li','',w)));}
  updateElapsed();
 }
 function updateElapsed(){elapsed.textContent=lastState.startedAt?'Elapsed '+Math.floor((Date.now()-lastState.startedAt)/1000)+'s':'';}
 for(const [mode,label,description]of MODES){const b=node('button','mtrace-action');b.type='button';b.append(node('strong','',label),node('span','',description));b.onclick=()=>void controller.run(mode);buttons.push(b);actions.append(b);}
 refresh.onclick=()=>void controller.refresh();download.onclick=()=>void controller.download();
 root.append(heading,lead,identity,actions,status,elapsed,details);container.append(root);controller.setContext(context.props);void controller.refresh();
 const interval=setInterval(()=>{if(context.presented!==false&&!disposed){controller.tick();updateElapsed();}},1000);
 function relevant(payload){const key=payload?.key??payload?.sessionKey??payload?.session?.key??payload?.session?.sessionKey;return !key||key===context.props.sessionKey;}
 const unsub=host.onEvent('sessions.changed',payload=>{if(disposed||!relevant(payload))return;const announced=payload?.session?.lifecycleRevision;const changed=/reset|clear|delete|replace/.test(String(payload?.reason??''))||(announced!==undefined&&lastState.identity&&announced!==lastState.identity.lifecycleRevision);if(changed)controller.invalidate('Session reset or changed. Create a new export.');if((changed||!lastState.identity)&&context.presented!==false&&!scheduled)scheduled=setTimeout(()=>{scheduled=null;void controller.refresh();},300);});
 return {update(next){const wasHidden=context.presented===false;context=next;if(controller.setContext(next.props)||wasHidden&&next.presented!==false)void controller.refresh();},focus(){buttons[0]?.focus();},dispose(){disposed=true;controller.dispose();clearInterval(interval);if(scheduled)clearTimeout(scheduled);unsub();root.remove();}};
}});}});
