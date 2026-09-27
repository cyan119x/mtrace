import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
const str={type:'string'},nullable={anyOf:[str,{type:'null'}]},integer={type:'integer',minimum:0};
const mode={type:'string',enum:['full','transcript','prompt-tool-runtime','history']};
const identity={agentId:str,sessionId:str,sessionKey:str,lifecycleRevision:nullable};
const result={artifactId:str,mode,filename:str,sizeBytes:integer,downloadUrl:str,expiresAt:str,sessionId:str,lifecycleRevision:nullable,scope:{type:'string',enum:['since-last-reset','full-session']},eventCount:integer,runtimeEventCount:integer,transcriptEventCount:integer,resetBoundaryAt:nullable,resetBoundaryEntryId:nullable,conversationStartedAt:nullable,conversationEndedAt:nullable,coverageStatus:{type:'string',enum:['complete','partial']},coverageWarnings:{type:'array',items:str}};
export const contract=defineFeatureContract({pluginId:'mtrace',operations:{
 status:{kind:'query',description:'Resolve the current authoritative session generation.',input:{type:'object',additionalProperties:false,properties:{}},output:{type:'object',additionalProperties:false,required:Object.keys(identity),properties:identity}},
 export:{kind:'action',description:'Build generation-fenced evidence with verified scope and explicit source coverage.',input:{type:'object',additionalProperties:false,required:['mode'],properties:{mode,expectedSessionId:str,expectedLifecycleRevision:nullable}},output:{type:'object',additionalProperties:false,required:Object.keys(result),properties:result}}
},events:{}});
