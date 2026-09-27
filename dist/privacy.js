import { redactToolPayloadText } from 'openclaw/plugin-sdk/logging-core';
const SECRET=/^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|pwd|secret|client[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|credential|credentials|private[-_]?key|session[-_]?cookie|download[-_]?token|download[-_]?url|thinking[-_]?signature|signature)$/i;
const PRIVATE=/^(?:providerReplay|reasoningContent|reasoning_content|thinking|reasoning)$/;
const MEDIA=/^(?:base64|b64_json|imageData|audioData|videoData|inlineData)$/i;
const LOSS_MARKERS=['[Truncated]','[Oversized diagnostic JSON redacted]','[Malformed diagnostic JSON redacted]','trajectory-field-size-limit','trajectory-depth-limit','trajectory-array-size-limit','trajectory-object-size-limit','trajectory-event-size-limit'];
export function createPrivacyProjector(){
 const stats={redactedFields:0,redactedStrings:0,sourceLossMarkers:0};
 function protectText(input,depth){
  if(input.length>16*1024*1024)throw new Error('Text exceeds safe export size; no partial artifact was produced');
  for(const marker of LOSS_MARKERS)if(input.includes(marker))stats.sourceLossMarkers++;
  // JSON strings are treated as structured content, not diagnostic previews.
  if(depth<48 && /^[\s]*[\[{]/.test(input)){
   try{const parsed=JSON.parse(input);const projected=visit(parsed,'',depth+1,new WeakSet());const next=JSON.stringify(projected);if(next!==JSON.stringify(parsed))return next;}catch(e){if(!(e instanceof SyntaxError))throw e;}
  }
  // The official text redactor preserves registered values AND configured extra patterns.
  let out=redactToolPayloadText(input);
  out=out.replace(/data:(?:image|audio|video|application)\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+/gi,'[Media bytes redacted]');
  out=out.replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,'$1[Credentials redacted]@');
  out=out.replace(/([?&](?:token|access_token|api_key|key|secret|signature|sig|code|auth)=)[^&#\s"'<>]+/gi,'$1[REDACTED]');
  out=out.replace(/((?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi,'$1[REDACTED]');
  if(out!==input)stats.redactedStrings++;
  return out;
 }
 function visit(v,key,depth,seen){
  if(SECRET.test(key)||/(?:password|passwd|secret|apikey|privatekey|accesstoken|refreshtoken|idtoken|authtoken|credential)s?$/i.test(key.replace(/[_-]/g,''))||/(?:^|_)token$/i.test(key)||PRIVATE.test(key)||MEDIA.test(key)){stats.redactedFields++;return '[Redacted]';}
  if(depth>96)throw new Error('Evidence nesting exceeds safe export depth; refusing partial output');
  if(key==='truncated'&&v===true)stats.sourceLossMarkers++;
  if(typeof v==='string')return protectText(v,depth);
  if(v===null||typeof v==='number'||typeof v==='boolean')return v;
  if(v===undefined)return null;
  if(typeof v!=='object')throw new Error('Non-JSON value in evidence');
  if(seen.has(v))throw new Error('Circular evidence payload');seen.add(v);
  let out;
  if(Array.isArray(v))out=v.map(x=>visit(x,'',depth+1,seen));
  else{
   out=Object.create(null);
   const kind=String(v.type??'');
   const media=/^(image|audio|video|image_url|input_image|input_audio)$/.test(kind)||/^(image|audio|video)\//.test(String(v.mimeType??v.mime_type??''));
   const privateThinking=/^(thinking|reasoning|redacted_thinking)$/.test(kind);
   const namedSecret=typeof (v.name??v.key)==='string'&&(SECRET.test(v.name??v.key)||/(?:TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(v.name??v.key));
   for(const [k,val]of Object.entries(v)){
    if(privateThinking&&k!=='type'||media&&/^(data|url|source|bytes|buffer)$/.test(k)||namedSecret&&k==='value'){
     out[k]='[Redacted]';stats.redactedFields++;
    }else{const safeKey=protectText(k,depth+1);if(Object.hasOwn(out,safeKey))throw new Error('Redacted field-name collision');out[safeKey]=visit(val,k,depth+1,seen);}
   }
  }
  seen.delete(v);return out;
 }
 return {stats,project:value=>visit(value,'',0,new WeakSet()),text:value=>protectText(String(value),0)};
}
