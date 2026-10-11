import test from "node:test";
import assert from "node:assert/strict";
import { selectCurrentConversation } from "../dist/current-conversation.js";

const msg=(id,parentId,role,text,ts,runId)=>({type:"message",id,parentId,timestamp:ts,message:{role,content:text,...(runId?{__openclaw:{runId}}:{})}});
const usr=(id,parentId,text,ts,runId)=>({type:"message",id,parentId,timestamp:ts,message:{role:"user",content:text,idempotencyKey:runId?`${runId}:user`:undefined}});
const reset=(id,parentId,ts)=>({type:"reset",id,parentId,timestamp:ts});
const rt=(ts,runId)=>({ts,runId});

test("selects only C after A-reset-B-reset-C",()=>{
  const branch=[usr("a",null,"A","2026-09-25T00:00:01Z","ra"),msg("aa","a","assistant","ok","2026-09-25T00:00:02Z","ra"),reset("r1","aa","2026-09-25T00:00:03Z"),usr("b","r1","B","2026-09-25T00:00:04Z","rb"),msg("ba","b","assistant","ok","2026-09-25T00:00:05Z","rb"),reset("r2","ba","2026-09-25T00:00:06Z"),usr("c","r2","C","2026-09-25T00:00:07Z","rc"),msg("ca","c","assistant","ok","2026-09-25T00:00:08Z","rc")];
  const out=selectCurrentConversation({branchEntries:branch,allEntries:branch,runtimeEvents:[rt("2026-09-25T00:00:02Z","ra"),rt("2026-09-25T00:00:05Z","rb"),rt("2026-09-25T00:00:08Z","rc")]});
  assert.deepEqual(out.selectedEntries.map(x=>x.id),["c","ca"]); assert.deepEqual(out.selectedRunIds,["rc"]); assert.equal(out.resetBoundaryEntryId,"r2");
});

test("keeps full active branch when no reset exists",()=>{
  const branch=[usr("u",null,"hello","2026-09-25T00:00:01Z","r"),msg("a","u","assistant","ok","2026-09-25T00:00:02Z","r")];
  const out=selectCurrentConversation({branchEntries:branch,allEntries:branch,runtimeEvents:[rt("2026-09-25T00:00:02Z","r")]});
  assert.equal(out.selectedEntries.length,2); assert.equal(out.resetBoundaryAt,undefined);
});

test("fails closed when no direct user follows latest reset",()=>{
  const branch=[usr("u",null,"hello","2026-09-25T00:00:01Z","r"),reset("x","u","2026-09-25T00:00:02Z")];
  assert.throws(()=>selectCurrentConversation({branchEntries:branch,allEntries:branch,runtimeEvents:[]}),/no direct user/i);
});

test("fails closed on unowned post-boundary runtime evidence",()=>{
  const branch=[usr("u",null,"hello","2026-09-25T00:00:01Z","r")];
  assert.throws(()=>selectCurrentConversation({branchEntries:branch,allEntries:branch,runtimeEvents:[rt("2026-09-25T00:00:02Z",undefined)]}),/no runId/i);
});

test("fails closed when selected run is also present off branch",()=>{
  const active=[usr("u",null,"hello","2026-09-25T00:00:01Z","r"),msg("a","u","assistant","ok","2026-09-25T00:00:02Z","r")];
  const all=[...active,msg("off","u","assistant","abandoned","2026-09-25T00:00:03Z","r")];
  assert.throws(()=>selectCurrentConversation({branchEntries:active,allEntries:all,runtimeEvents:[rt("2026-09-25T00:00:02Z","r")]}),/off-branch/i);
});
