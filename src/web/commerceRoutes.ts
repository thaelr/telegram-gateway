import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebCommerceService } from './commerce.js';
import { WebAuthError, type WebAuthenticator } from './auth.js';
import { WebError, type WebRepositoryContract } from './types.js';
import { ProviderError } from '../payments/providers.js';

export type WebCommerceRoutesOptions={authenticator:WebAuthenticator;repository:WebRepositoryContract;commerce:WebCommerceService};
const chatCode=z.string().regex(/^c[a-z0-9]{7}$/);
const clientId=z.string().trim().min(1).max(128);
const providerId=z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export function registerWebCommerceRoutes(app:FastifyInstance,options:WebCommerceRoutesOptions){
 const errors:Parameters<FastifyInstance['setErrorHandler']>[0]=(error,request,reply)=>{
  if(error instanceof WebError||error instanceof WebAuthError||error instanceof ProviderError)return reply.status(error.statusCode).send({error:error.code});
  if(error instanceof z.ZodError)return reply.status(400).send({error:'invalid_request'});
  if(typeof error==='object'&&error!==null&&'statusCode' in error&&typeof error.statusCode==='number'&&[400,413,415].includes(error.statusCode))return reply.status(error.statusCode).send({error:'invalid_request'});
  request.log.error({request_id:request.id},'Web Commerce operation failed');return reply.status(500).send({error:'internal_error',request_id:request.id});
 };
 void app.register(async scope=>{
  scope.setErrorHandler(errors);
  const users=new WeakMap<FastifyRequest,string>();
  const user=(r:FastifyRequest)=>{const id=users.get(r);if(!id)throw new WebError(401,'unauthorized');return id;};
  scope.addHook('onRequest',async(request,reply)=>{
   reply.header('Cache-Control','no-store');reply.header('Vary','Authorization');
   const identity=await options.authenticator.verify(request.headers.authorization);
   const id=await options.repository.resolveIdentity(identity.auth_user_id);if(!id)throw new WebError(409,'bootstrap_required');users.set(request,id);
  });
  scope.get('/web/commerce/catalog',async request=>{const q=z.object({chat_code:chatCode.optional()}).strict().parse(request.query);return options.commerce.catalog(user(request),q.chat_code);});
  scope.get('/web/commerce/entitlements',async request=>options.commerce.entitlements(user(request)));
  scope.post('/web/commerce/purchases',async(request,reply)=>{
   const input=z.object({client_message_id:clientId,chat_code:chatCode,sku:z.string().trim().min(1).max(120),provider:providerId,media_id:z.string().uuid().optional(),subscription_change:z.enum(['renew','upgrade']).optional()}).strict().parse(request.body);
   return reply.status(202).send(await options.commerce.purchase(user(request),input));
  });
  scope.get('/web/commerce/purchases/:purchase_id',async request=>{const p=z.object({purchase_id:z.string().uuid()}).strict().parse(request.params);return options.commerce.status(user(request),p.purchase_id);});
  scope.get('/web/chats/:chat_code/media',async request=>{const p=z.object({chat_code:chatCode}).strict().parse(request.params);return options.commerce.gallery(user(request),p.chat_code);});
  scope.get('/web/chats/:chat_code/media/:media_id/video',async request=>{
   const p=z.object({chat_code:chatCode,media_id:z.string().uuid()}).strict().parse(request.params);
   return options.commerce.videoAvailability(user(request),p.chat_code,p.media_id);
  });
  scope.post('/web/chats/:chat_code/media/:media_id/video',async(request,reply)=>{
   const p=z.object({chat_code:chatCode,media_id:z.string().uuid()}).strict().parse(request.params);
   const input=z.object({client_message_id:clientId}).strict().parse(request.body);
   return reply.status(202).send(await options.commerce.requestVideo(user(request),p.chat_code,p.media_id,input.client_message_id));
  });
  scope.get('/web/commerce/video-deliveries/:delivery_id',async request=>{
   const p=z.object({delivery_id:z.string().uuid()}).strict().parse(request.params);
   return options.commerce.videoAccess(user(request),p.delivery_id);
  });
  scope.post('/web/chats/:chat_code/media/:media_id/unlock',async(request,reply)=>{
   const p=z.object({chat_code:chatCode,media_id:z.string().uuid()}).strict().parse(request.params);
   const input=z.object({client_message_id:clientId,provider:providerId.optional()}).strict().parse(request.body);
   return reply.send(await options.commerce.unlock(user(request),p.chat_code,p.media_id,input));
  });
 });
 // Separate encapsulated scope: signatures verify the original JSON text. No bearer token here.
 void app.register(async scope=>{
  scope.setErrorHandler(errors);
  scope.removeContentTypeParser('application/json');
  scope.addContentTypeParser('application/json',{parseAs:'string',bodyLimit:65536},(_req,body,done)=>done(null,body));
  scope.post('/web/commerce/nowpayments/ipn',async request=>{
   if(typeof request.body!=='string')throw new WebError(400,'invalid_request');
   const sig=request.headers['x-nowpayments-sig'];
   if(Array.isArray(sig))throw new WebError(401,'invalid_signature');
   return options.commerce.notification('nowpayments',request.body,sig);
  });
 });
}
