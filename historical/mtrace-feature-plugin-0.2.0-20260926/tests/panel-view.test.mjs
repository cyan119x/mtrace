import test from 'node:test';import assert from 'node:assert/strict';import plugin from '../src/control-ui.js';
class Element{
 constructor(tag,doc){this.tag=tag;this.ownerDocument=doc;this.children=[];this.attributes={};this.dataset={};this._text='';this.hidden=false;this.disabled=false;}
 set textContent(s){this._text=String(s);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent??String(c)).join('');}
 append(...children){for(const c of children){c.parent=this;this.children.push(c);}}
 replaceChildren(...c){this.children=[];this.append(...c);}setAttribute(k,v){this.attributes[k]=v;}remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}focus(){this.focused=true;}click(){this.onclick?.();}
}
const doc={createElement(tag){return new Element(tag,this);}};
const walk=root=>[root,...root.children.flatMap(walk)];
const flush=()=>new Promise(r=>setImmediate(r));
function rig(t){let definition,context,view,statusQueries=0,revision='one',pending;
 const container=new Element('aside',doc);const listeners=new Map();const signal=new AbortController().signal;
 const id=()=>({agentId:'main',sessionKey:context.props.sessionKey,sessionId:context.props.sessionKey,lifecycleRevision:revision});
 const host={pluginId:'mtrace',signal,onEvent(name,fn){listeners.set(name,fn);return ()=>listeners.delete(name);},ui:{registerPanel(def){definition=def;return ()=>{};}},async request(method,params){assert.equal(method,'plugins.sessionAction');if(params.actionId==='status'){statusQueries++;return {ok:true,result:id()};}if(pending)return pending;return {ok:true,result:{...id(),artifactId:'id',mode:params.payload.mode,filename:'test.md',sizeBytes:5,downloadUrl:'/__openclaw__/plugins/mtrace/download/id?token=secret',expiresAt:'2099-01-01T00:00:00Z',scope:'since-last-reset',eventCount:2,transcriptEventCount:1,runtimeEventCount:1,resetBoundaryAt:'2026-09-26T03:24:22Z',conversationStartedAt:'2026-09-26T03:26:06Z',conversationEndedAt:'2026-09-26T04:00:00Z',coverageStatus:'partial',coverageWarnings:['Source evidence is partial.']}};}};
 context={host,signal,props:{agentId:'main',sessionKey:'session-one'},presented:true};plugin.activate(host);view=definition.mount(container,context);t.after(()=>view.dispose());
 return {container,view,context,host,listeners,queries:()=>statusQueries,reset(){revision='two';listeners.get('sessions.changed')({key:'session-one',reason:'reset'});},setPending(p){pending=p;},button(label){return walk(container).find(n=>n.tag==='button'&&n.textContent.startsWith(label));},nodes:()=>walk(container)};
}
test('real native SDK + view mounts and resolves identity',async t=>{const r=rig(t);await flush();assert.ok(r.container.textContent.includes('Session session-one'));assert.equal(r.queries(),1);assert.equal(r.nodes().filter(n=>n.className==='mtrace-action').length,4);});
test('ordinary host updates do not create status refresh/layout storms',async t=>{const r=rig(t);await flush();const root=r.container.children[0];for(let i=0;i<50;i++)r.view.update({...r.context});await flush();assert.equal(r.queries(),1);assert.equal(r.container.children[0],root);});
test('view renders native feature result metadata and warnings',async t=>{const r=rig(t);await flush();r.button('Full evidence').click();await flush();await flush();assert.ok(r.container.textContent.includes('Ready for one download'));assert.ok(r.container.textContent.includes('2 events: 1 transcript + 1 runtime'));assert.ok(r.container.textContent.includes('Source evidence is partial.'));assert.equal(r.button('Download once').disabled,false);});
test('same-key native reset removes ready download immediately',async t=>{const r=rig(t);await flush();r.button('Full evidence').click();await flush();await flush();r.reset();assert.ok(r.container.textContent.includes('Session reset or changed'));assert.equal(r.nodes().find(n=>n.className==='mtrace-result').hidden,true);});
test('host session switch replaces identity without remount',async t=>{const r=rig(t);await flush();const root=r.container.children[0];const next={...r.context,props:{agentId:'main',sessionKey:'session-two'}};r.context.props=next.props;r.view.update(next);await flush();assert.equal(r.container.children[0],root);assert.ok(r.container.textContent.includes('Session session-two'));});

test('ordinary sessions.changed metadata does not query identity repeatedly',async t=>{const r=rig(t);await flush();for(let i=0;i<50;i++)r.listeners.get('sessions.changed')({key:'session-one',reason:'patch'});await new Promise(resolve=>setTimeout(resolve,350));assert.equal(r.queries(),1);});
