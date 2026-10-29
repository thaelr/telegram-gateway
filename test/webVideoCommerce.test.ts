import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { installTestEnv } from './testEnv.js';
import type { WebCommerceQuote, WebCommerceRepository, WebPurchase } from '../src/web/commerceRepository.js';
import type { MediaCommerceDecisionService } from '../src/mediaCommerceDecisionService.js';
import type { PaymentProviderRegistry } from '../src/payments/providers.js';
import type { WebRepositoryContract } from '../src/web/types.js';

process.env.NODE_ENV='test';installTestEnv();
const basePlan={sku:'base',amount_xtr:30,amount_rub:300,title:'Base',description:'Base benefits',label:'Base',button_text:'Buy',days:14};
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([basePlan,{...basePlan,sku:'full',tier:'full',days:30,amount_xtr:100,amount_rub:1000}]);
const {days: _days,...invoicePlan}=basePlan;
process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{...invoicePlan,sku:'photo'}]);
process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...invoicePlan,sku:'video',feature_key:'video_unlock'}]);
process.env.MEDIA_VIDEO_ENABLED='true';
process.env.SUPABASE_URL='https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY='test-server-key';
const {config}=await import('../src/config.js');
const {WebCommerceService}=await import('../src/web/commerce.js');
const {WebVideoAccess}=await import('../src/web/videoAccess.js');
const {registerWebCommerceRoutes}=await import('../src/web/commerceRoutes.js');
const {WebError}=await import('../src/web/types.js');
const photo='11111111-1111-4111-8111-111111111111', video='22222222-2222-4222-8222-222222222222', deliveryId='33333333-3333-4333-8333-333333333333';
const context={chat_id:100,chat_code:'c0000001',character_i:1,scene_session_id:'scene-a',turn_no:5,scene_turn_no:3,scene_mode:'fast' as const};
const rights={subscription_sku:'base',subscription_until:'2099-01-01T00:00:00Z',full_active:false};
const plans=[{sku:'video',kind:'feature',feature_key:'video_unlock',amount_xtr:20,amount_rub:200,title:'Video',description:'One video'}, {sku:'pass',kind:'feature',feature_key:'video_pass',amount_xtr:50,amount_rub:500,title:'VideoPass',description:'Current scene'}, {sku:'full',kind:'subscription',subscription_tier:'full',subscription_days:30,amount_xtr:85,amount_rub:850,upgrade_full_amount_xtr:85.25,upgrade_full_amount_rub:850.25,title:'Full',description:'Base and video'}];
function fixture(){
 let saved:WebPurchase|undefined;
 const repo={
  getContext:async()=>context, getEntitlements:async()=>rights,
  getOffer:async()=>({...context,media_id:photo,media_signature:'lounge_close_sitting_dress_front',panel_id:-10,sku:'photo'}),
  findByClient:async()=>saved??null,redeemFreeFeature:async()=>({available:false}),claimCreation:async()=>false,
  createOrGet:async(_u:string,_c:string,fingerprint:string,quote:WebCommerceQuote,provider:string)=>{saved={purchase_id:'44444444-4444-4444-8444-444444444444',quote,provider,chat_id:100,payment_token:'invoice',status:'created',fingerprint,created_at:'2026-10-28T00:00:00Z',updated_at:'2026-10-28T00:00:00Z'} as WebPurchase;return {purchase:saved,created:true};},
  getOwned:async()=>saved,
  videos:{context:async()=>({video:{video_id:video,bucket_name:'private-video',storage_path:'synthetic.mp4'},full_active:false,video_pass_active:false,scene_active:true,panel_delivered:false})},
 };
 const providers={list:()=>['test'],get:()=>({id:'test'})} as unknown as PaymentProviderRegistry;
 const decisions={webProductPlans:async()=>plans} as unknown as MediaCommerceDecisionService;
 const accounts={getMe:async()=>({age_confirmed_at:'2026-01-01',terms_accepted_at:'2026-01-01'})} as unknown as WebRepositoryContract;
 return {repo,service:new WebCommerceService(repo as unknown as WebCommerceRepository,providers,decisions,accounts),snapshot:()=>saved!};
}
test('Web video checkout freezes server-selected video, scene and source photo panel; repeat returns same operation',async()=>{
 const f=fixture();const input={client_message_id:'buy-1',chat_code:context.chat_code,sku:'video',provider:'test',media_id:photo};
 const first=await f.service.purchase('u0000001',input),second=await f.service.purchase('u0000001',input);
 assert.deepEqual(second,first);assert.equal(f.snapshot().quote.video_id,video);assert.equal(f.snapshot().quote.panel_id,-10);assert.equal(f.snapshot().quote.scene_session_id,'scene-a');
 assert.equal('storage_path' in first,false);
 await assert.rejects(f.service.purchase('u0000001',{...input,media_id:video}),e=>e instanceof WebError&&e.code==='idempotency_conflict');
});
test('Web rejects one-video purchase without photo and rejects duplicate entitlement purchase',async()=>{
 const f=fixture();await assert.rejects(f.service.purchase('u0000001',{client_message_id:'x',chat_code:context.chat_code,sku:'video',provider:'test'}),e=>e instanceof WebError&&e.code==='media_id_required');
 f.repo.videos.context=async()=>({video:{video_id:video,bucket_name:'private',storage_path:'x.mp4'},full_active:true,video_pass_active:false,scene_active:true,panel_delivered:false});
 await assert.rejects(f.service.purchase('u0000001',{client_message_id:'y',chat_code:context.chat_code,sku:'video',provider:'test',media_id:photo}),e=>e instanceof WebError&&e.code==='video_already_available');
});
test('Web upgrade subtracts nominal Base and freezes independent discounts without time proration',async(t)=>{
 const old=config.MEDIA_UPGRADE_DISCOUNT_PERCENT;config.MEDIA_UPGRADE_DISCOUNT_PERCENT=20;t.after(()=>{config.MEDIA_UPGRADE_DISCOUNT_PERCENT=old;});
 const f=fixture();await f.service.purchase('u0000001',{client_message_id:'upgrade',chat_code:context.chat_code,sku:'full',provider:'test',subscription_change:'upgrade'});
 assert.equal(f.snapshot().quote.amount,'449');assert.equal(f.snapshot().quote.amount_xtr,49);assert.equal(f.snapshot().quote.subscription_days,30);
 assert.equal(f.snapshot().quote.payload?.base_sku,'base');assert.equal(f.snapshot().quote.payload?.subscription_change,'upgrade');
});
test('Web catalog preserves subscription descriptions and exposes an explicit upgrade quote',async()=>{
 const f=fixture();const catalog=await f.service.catalog('u0000001',context.chat_code);const full=catalog.products.find(p=>p.sku==='full');
 assert.equal(full?.description,'Base and video');assert.equal(full?.upgrade?.base_sku,'base');assert.equal(full?.subscription_days,30);
});
test('Web video routes authenticate and reject caller-controlled account, video and storage identities',async(t)=>{
 const app=Fastify();t.after(()=>app.close());const calls:string[]=[];
 registerWebCommerceRoutes(app,{authenticator:{async verify(header){if(header!=='Bearer valid')throw new WebError(401,'unauthorized');return {auth_user_id:'auth',is_anonymous:false,display_name:null,locale:null};}},repository:{resolveIdentity:async()=> 'u0000001'} as unknown as WebRepositoryContract,commerce:{requestVideo:async(user:string)=>{calls.push(user);return {delivery_id:deliveryId};}} as unknown as InstanceType<typeof WebCommerceService>});
 const url=`/web/chats/${context.chat_code}/media/${photo}/video`;
 assert.equal((await app.inject({method:'POST',url,payload:{client_message_id:'x'}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer valid'},payload:{client_message_id:'x',video_id:video}})).statusCode,400);
 const good=await app.inject({method:'POST',url,headers:{authorization:'Bearer valid'},payload:{client_message_id:'x'}});assert.equal(good.statusCode,202);assert.equal(good.headers['cache-control'],'no-store');assert.deepEqual(calls,['u0000001']);
});
function deliveryFixture(){
 let now=Date.parse('2026-10-28T10:00:00Z');
 const row:any={delivery_id:deliveryId,user_id:'u0000001',source:'web',video_id:video,status:'queued',eligible_at:new Date(now+5000).toISOString(),bucket_name:'private',storage_path:'synthetic.mp4',claim_token:null};
 const signed:number[]=[];
 const db={unsafe:async(statement:string,args:any[])=>{
  if(statement.includes('FROM app_private.video_deliveries'))return args[0]===row.user_id?[{...row}]:[];
  if(statement.includes('media_claim_video_delivery')){if(['queued','failed'].includes(row.status)){row.status='sending';row.claim_token=args[1];}return [{result:row}];}
  if(statement.includes('media_complete_video_delivery')){assert.equal(args[1],row.claim_token);row.status='delivered';row.delivered_at=new Date(now).toISOString();return [{result:row}];}
  if(statement.includes('media_fail_video_delivery')){row.status='failed';return [{result:row}];}
  throw new Error('Unexpected SQL');
 }};
 const signer=async(_b:string,_p:string,ttl=120)=>{signed.push(ttl);return 'https://example.invalid/signed-video';};
 const access=new WebVideoAccess(db as any,signer,()=>now);
 return {row,signed,access,advance:(ms:number)=>{now+=ms;},db,now:()=>now};
}
test('Web video delivery waits five seconds, checks ownership, claims once and limits response-loss recovery to the original window',async()=>{
 const f=deliveryFixture();await assert.rejects(f.access.access('other',deliveryId),e=>e instanceof WebError&&e.code==='video_delivery_not_found');
 assert.equal((await f.access.access('u0000001',deliveryId)).status,'queued');assert.deepEqual(f.signed,[]);
 f.advance(5000);assert.equal((await f.access.access('u0000001',deliveryId)).status,'delivered');assert.deepEqual(f.signed,[120]);
 f.advance(20000);await f.access.access('u0000001',deliveryId);assert.deepEqual(f.signed,[120,100]);
 f.advance(100001);await assert.rejects(f.access.access('u0000001',deliveryId),e=>e instanceof WebError&&e.code==='video_delivery_expired');
});
test('Web storage signing failure keeps the same paid operation retryable',async()=>{
 const f=deliveryFixture();f.advance(5000);let attempts=0;
 const access=new WebVideoAccess(f.db as any,async()=>{if(++attempts===1)throw new Error('network');return 'https://example.invalid/signed';},f.now);
 await assert.rejects(access.access('u0000001',deliveryId),e=>e instanceof WebError&&e.code==='video_delivery_retryable');assert.equal(f.row.status,'failed');
 assert.equal((await access.access('u0000001',deliveryId)).status,'delivered');assert.equal(attempts,2);
});
test('Web uncertain delivery never auto-claims or signs a second time',async()=>{
 const f=deliveryFixture();f.advance(6000);f.row.status='uncertain';assert.equal((await f.access.access('u0000001',deliveryId)).status,'uncertain');assert.deepEqual(f.signed,[]);
});
