// Development-only resolution of public OpenClaw SDK imports on this host.
export async function resolve(specifier,context,nextResolve){
 if(specifier.startsWith('openclaw/plugin-sdk/'))return nextResolve('file:///path/to/openclaw/dist/plugin-sdk/'+specifier.slice('openclaw/plugin-sdk/'.length)+'.js',context);
 return nextResolve(specifier,context);
}

export async function load(url,context,nextLoad){if(url.endsWith('.css'))return {format:'module',source:'export default {};',shortCircuit:true};return nextLoad(url,context);}
