export const DOWNLOAD_ROOT='/__openclaw__/plugins/mtrace/download/';
export function createDownloadHandler({inspect,take}){
 return async function handler(req,res){
  const url=new URL(req.url||'/','http://localhost');
  if(!url.pathname.startsWith(DOWNLOAD_ROOT))return false;
  for(const [k,v]of Object.entries({'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}))res.setHeader(k,v);
  if(!['GET','HEAD'].includes(req.method)){res.statusCode=405;res.setHeader('Allow','GET, HEAD');res.end();return true;}
  const id=url.pathname.slice(DOWNLOAD_ROOT.length),token=url.searchParams.get('token')||'';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)){res.statusCode=404;res.end();return true;}
  const artifact=req.method==='HEAD'?inspect(id,token):take(id,token);
  if(!artifact){res.statusCode=404;res.end();return true;}
  res.statusCode=200;res.setHeader('Content-Type','text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(artifact.filename));
  res.setHeader('Content-Length',String(artifact.sizeBytes));
  if(req.method==='HEAD')res.end();else res.end(Buffer.from(artifact.text,'utf8'));
  return true;
 };
}
