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
function contextKey(context){ return `${context.props.agentId}\u0000${context.props.sessionKey}`; }
export default defineControlUiPlugin({
  id:"mtrace",
  activate(host){
    return host.ui.registerPanel({
      id:"mtrace", label:"MTrace",
      mount(container,context){
        let current=context;
        let disposed=false;
        let identityRequest=0;
        let resolvedIdentityKey="";
        const feature=createFeatureClient(contract,host);
        const root=document.createElement("section"); root.className="mtrace-plugin";
        const title=document.createElement("h2"); title.textContent="MTrace · Session export";
        const identity=document.createElement("div"); identity.className="mtrace-identity";
        const status=document.createElement("output"); status.className="mtrace-status"; status.setAttribute("aria-live","polite");
        const grid=document.createElement("div"); grid.className="mtrace-grid";

        const refreshIdentity=async(force=false)=>{
          const key=contextKey(current);
          if(!force && resolvedIdentityKey===key) return;
          const request=++identityRequest;
          const sessionKey=current.props.sessionKey;
          const agentId=current.props.agentId;
          if(!identity.textContent) identity.textContent=`Session: ${sessionKey}`;
          try{
            const r=await feature.invoke("status",{}, {sessionKey,agentId});
            if(disposed || request!==identityRequest || contextKey(current)!==key) return;
            identity.textContent=`Session: ${r.sessionId} · ${r.sessionKey}`;
            resolvedIdentityKey=key;
          }catch(e){
            if(disposed || request!==identityRequest || contextKey(current)!==key) return;
            status.textContent=String(e);
          }
        };

        for(const [mode,label,description] of actions){
          const card=document.createElement("button"); card.type="button"; card.className="mtrace-action";
          const strong=document.createElement("strong"); strong.textContent=label;
          const small=document.createElement("span"); small.textContent=description;
          card.append(strong,small);
          card.onclick=async()=>{
            const buttons=[...grid.querySelectorAll("button")]; buttons.forEach((b)=>b.disabled=true);
            status.textContent=`Creating ${label} export…`;
            try{
              const r=await feature.invoke("export",{mode},{sessionKey:current.props.sessionKey,agentId:current.props.agentId});
              if(disposed)return;
              status.textContent=`Ready: ${r.filename} · ${fmtBytes(r.sizeBytes)}`;
              const a=document.createElement("a"); a.href=r.downloadUrl; a.download=r.filename; a.textContent="Download once"; a.className="mtrace-download";
              status.append(document.createTextNode(" · "),a);
            }catch(e){
              if(!disposed) status.textContent=`Export failed: ${e instanceof Error?e.message:String(e)}`;
            }finally{
              if(!disposed) buttons.forEach((b)=>b.disabled=false);
            }
          };
          grid.append(card);
        }
        root.append(title,identity,grid,status); container.append(root); void refreshIdentity(true);
        return {
          update(next){
            const previousKey=contextKey(current);
            current=next;
            const nextKey=contextKey(next);
            if(previousKey!==nextKey){
              identityRequest++;
              resolvedIdentityKey="";
              identity.textContent=`Session: ${next.props.sessionKey}`;
              status.textContent="";
              void refreshIdentity(true);
            }
          },
          focus(){ grid.querySelector("button")?.focus(); },
          dispose(){ disposed=true; identityRequest++; root.remove(); }
        };
      }
    });
  }
});
