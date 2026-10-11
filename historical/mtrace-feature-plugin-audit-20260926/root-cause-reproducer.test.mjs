// Reproduces existing defects, not acceptance of a fixed product. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { t as sanitize } from '/path/to/openclaw/dist/payload-redaction-DPHUXa81.mjs';
import { selectCurrentConversation as current } from '/path/to/historical-sources/mtrace-feature-plugin-0.1.2-20260925/dist/current-conversation.js';
import { selectCurrentConversation as previous } from '/path/to/historical-sources/mtrace-feature-plugin-20260925/dist/current-conversation.js';
const old=Array.from({length:100},(_,i)=>({type:'message',id:'old'+i,parentId:i?'old'+(i-1):null,timestamp:new Date(Date.UTC(2026,8,25,0,0,i)).toISOString(),message:{role:i?'assistant':'user',content:'synthetic old',__openclaw:{runId:'old-run'}}}));
const reset={type:'reset',id:'reset',parentId:'old99',timestamp:'2026-09-26T03:24:00.000Z'};
const hello={type:'message',id:'hello',parentId:'reset',timestamp:'2026-09-26T03:26:00.000Z',message:{role:'user',content:'synthetic hello',__openclaw:{runId:'new-run'}}};
const branch=[...old,reset,hello];
const runtime=[{ts:'2026-09-25T00:00:01.000Z',runId:'old-run'},{ts:'2026-09-26T03:26:01.000Z',runId:'new-run'}];
const projected=sanitize({header:{type:'session'},leafId:'hello',entries:branch}).entries;
const invoke=(selector,entries)=>selector({branchEntries:entries,allEntries:branch,runtimeEvents:runtime});
test('control: intact structural input selects only post-reset hello',()=>{const out=invoke(current,branch);assert.deepEqual(out.selectedEntries.map(e=>e.id),['hello']);assert.deepEqual(out.selectedRunIds,['new-run']);assert.equal(out.resetBoundaryEntryId,'reset');});
test('defect reproduced: diagnostic branch projection loses reset beyond 64 keys',()=>{assert.equal(projected.length,64);assert.equal(projected.some(e=>e?.type==='reset'),false);assert.ok(projected.includes('[Truncated]'));});
test('defect reproduced: 0.1.2 accepts corrupted branch and selects old run',()=>{const out=invoke(current,projected);assert.equal(out.resetBoundaryAt,undefined);assert.deepEqual(out.selectedRunIds,['old-run']);assert.equal(out.selectedEntries.some(e=>e?.id==='hello'),false);});
test('historical defect reproduced: 0.1.0 reports false off-branch conflict on same corrupt input',()=>{assert.throws(()=>invoke(previous,projected),/shared with an off-branch/);});
