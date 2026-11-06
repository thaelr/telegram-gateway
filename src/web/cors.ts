import type { FastifyInstance } from 'fastify';

/** Browser transport for the existing Web API. Internal /v1 routes and provider
 * callbacks without Origin are unaffected. Bearer authorization is still required.
 */
export function registerWebCors(app:FastifyInstance,allowedOrigins:readonly string[]):void {
 const allowed=new Set(allowedOrigins);
 const methods=new Set(['GET','POST','PATCH']);
 const headers=new Set(['authorization','content-type']);
 app.addHook('onRequest',async(request,reply)=>{
  if(!request.raw.url?.startsWith('/web/'))return;
  const origin=request.headers.origin;
  if(!origin)return;
  const sameOrigin=origin===`${request.protocol}://${request.headers.host}`;
  if(!allowed.has(origin)&&!sameOrigin)return reply.status(403).send({error:'origin_not_allowed'});
  if(request.method==='OPTIONS'){
   const method=request.headers['access-control-request-method'];
   const requested=String(request.headers['access-control-request-headers']??'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
   if(typeof method!=='string'||!methods.has(method)||requested.some(header=>!headers.has(header)))return reply.status(403).send({error:'cors_request_not_allowed'});
   reply.header('Access-Control-Allow-Methods','GET, POST, PATCH');
   reply.header('Access-Control-Allow-Headers','Authorization, Content-Type');
   reply.header('Access-Control-Max-Age','600');
   return reply.status(204).send();
  }
 });
 app.addHook('onSend',async(request,reply,payload)=>{
  if(!request.raw.url?.startsWith('/web/'))return payload;
  const vary=String(reply.getHeader('Vary')??'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!vary.some(x=>x.toLowerCase()==='origin'))vary.push('Origin');
  reply.header('Vary',vary.join(', '));
  const origin=request.headers.origin;
  if(origin&&(allowed.has(origin)||origin===`${request.protocol}://${request.headers.host}`))reply.header('Access-Control-Allow-Origin',origin);
  return payload;
 });
 app.options('/web/*',async(_request,reply)=>reply.status(204).send());
}
