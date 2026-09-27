import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "../dist/contract.js";
import "./control-ui.css";

const actions = [
  ["full","Full evidence","Current conversation: transcript + runtime/tool evidence"],
  ["transcript","Transcript","Current conversation transcript only"],
  ["prompt-tool-runtime","Prompt + tool/runtime","Current conversation prompt, tool and runtime evidence"],
  ["history","Full sidebar-session history","Forensic export across every retained reset epoch"]
];
function fmtBytes(n){ if(n<1024)return `${n} B`; if(n<1048576)return `${(n/1024).toFixed(1)} KB`; return `${(n/1048576).toFixed(1)} MB`; }
export default defineControlUiPlugin({
  id:"mtrace",
  activate(host){
    return host.ui.registerPanel({
      id:"mtrace", label:"MTrace",
      mount(container,context){
        let current=context; const feature=createFeatureClient(contract,host); const root=document.createElement("section"); root.className="mtrace-plugin";
        const title=document.createElement("h2"); title.textContent="MTrace · Session export";
        const identity=document.createElement("div"); identity.className="mtrace-identity";
        const status=document.createElement("output"); status.className="mtrace-status"; status.setAttribute("aria-live","polite");
        const grid=document.createElement("div"); grid.className="mtrace-grid";
        const refreshIdentity=async()=>{ identity.textContent=`Session: ${current.props.sessionKey}`; try{ const r=await feature.invoke("status",{}, {sessionKey:current.props.sessionKey,agentId:current.props.agentId}); if(!current.signal.aborted) identity.textContent=`Session: ${r.sessionId} · ${r.sessionKey}`; }catch(e){ if(!current.signal.aborted) status.textContent=String(e); } };
        for(const [mode,label,description] of actions){ const card=document.createElement("button"); card.type="button"; card.className="mtrace-action"; const strong=document.createElement("strong"); strong.textContent=label; const small=document.createElement("span"); small.textContent=description; card.append(strong,small); card.onclick=async()=>{ const buttons=[...grid.querySelectorAll("button")]; buttons.forEach((b)=>b.disabled=true); status.textContent=`Creating ${label} export…`; try{ const r=await feature.invoke("export",{mode},{sessionKey:current.props.sessionKey,agentId:current.props.agentId}); if(current.signal.aborted)return; status.textContent=`Ready: ${r.filename} · ${fmtBytes(r.sizeBytes)}`; const a=document.createElement("a"); a.href=r.downloadUrl; a.download=r.filename; a.textContent="Download once"; a.className="mtrace-download"; status.append(document.createTextNode(" · "),a); }catch(e){ if(!current.signal.aborted) status.textContent=`Export failed: ${e instanceof Error?e.message:String(e)}`; }finally{ if(!current.signal.aborted) buttons.forEach((b)=>b.disabled=false); } }; grid.append(card); }
        root.append(title,identity,grid,status); container.append(root); void refreshIdentity();
        return { update(next){ current=next; status.textContent=""; void refreshIdentity(); }, focus(){ grid.querySelector("button")?.focus(); }, dispose(){ root.remove(); } };
      }
    });
  }
});
