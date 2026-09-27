import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { runCommandWithTimeout } from 'openclaw/plugin-sdk/process-runtime';
export async function archiveWorkspace(workspace,reason){
 const batch=path.join(os.homedir(),'Archive-Pending-Delete',new Date().toISOString().slice(0,10)+'-mtrace-cli-'+crypto.randomUUID());
 await fs.mkdir(batch,{recursive:true,mode:0o700});
 const destination=path.join(batch,'workspace');
 await fs.rename(workspace,destination);
 await fs.writeFile(path.join(batch,'MANIFEST.md'),'# MTrace transient CLI bundle archive\n\nOriginal: '+workspace+'\nDestination: '+destination+'\nTime: '+new Date().toISOString()+'\nReason: '+reason+'\nReferences: one-shot CLI process settled; plugin retains no file references. Download body lives in bounded memory. Content is private even after exporter sanitization. No permanent deletion authorized.\n',{mode:0o600});
}
export async function readRuntimeViaCli(identity){
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'mtrace-cli-workspace-'));await fs.chmod(workspace,0o700);
 let outcome='CLI export complete';
 try{
  const output='mtrace-'+crypto.randomUUID();
  const request=Buffer.from(JSON.stringify({sessionKey:identity.sessionKey,agent:identity.agentId,workspace,output})).toString('base64url');
  const result=await runCommandWithTimeout([process.env.OPENCLAW_BIN?.trim()||'openclaw','sessions','export-trajectory','--request-json-base64',request,'--json'],{timeoutMs:120000,cwd:workspace,env:process.env});
  if(result.code!==0)throw new Error('Official trajectory export did not complete. Transcript mode remains available.');
  let summary;try{summary=JSON.parse(result.stdout);}catch{throw new Error('Official trajectory export returned invalid metadata');}
  const outputDir=path.resolve(summary.outputDir||path.join(workspace,'.openclaw','trajectory-exports',output));
  const inside=(a,b)=>{const rel=path.relative(a,b);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
  if(!inside(workspace,outputDir))throw new Error('Exporter returned an invalid bundle path');
  const file=path.join(outputDir,'events.jsonl');const st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>67108864||!inside(await fs.realpath(workspace),await fs.realpath(file)))throw new Error('Unsafe or oversized runtime bundle');
  const rows=[];
  for(const line of (await fs.readFile(file,'utf8')).split(/\r?\n/)){
   if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{throw new Error('Malformed runtime event stream');}
   if(r.source==='runtime'){if(rows.length>=100000)throw new Error('Runtime event count exceeds safe export capacity');rows.push(r);}
  }
  return rows;
 }catch(e){outcome='CLI export failed; retained for owner-controlled cleanup';throw e;}
 finally{await archiveWorkspace(workspace,outcome);}
}
