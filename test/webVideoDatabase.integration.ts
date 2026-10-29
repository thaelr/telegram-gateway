import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {installTestEnv} from './testEnv.js';

test('Web video and Full use the real local PostgreSQL Commerce ledger',async(t)=>{
 const url=process.env.TEST_DATABASE_URL;if(!url)throw new Error('TEST_DATABASE_URL required');
 const parsed=new URL(url);assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname)&&parsed.pathname.includes('test'),'Isolated local test DB required');
 process.env.NODE_ENV='test';process.env.DATABASE_URL=url;installTestEnv();
 const invoice={title:'Neutral test',description:'Neutral synthetic product',label:'Test',button_text:'Buy',amount_xtr:10,amount_rub:100};
 process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...invoice,sku:'test_base_video',days:7,amount_rub:300,amount_xtr:30},{...invoice,sku:'test_full_video',tier:'full',days:30,amount_rub:1000,amount_xtr:100}]);
 process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{...invoice,sku:'test_photo_video'}]);
 process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...invoice,sku:'test_video_unlock',feature_key:'video_unlock'},{...invoice,sku:'test_video_pass',feature_key:'video_pass',amount_rub:500}]);
 process.env.MEDIA_VIDEO_ENABLED='true';process.env.MEDIA_UPGRADE_DISCOUNT_PERCENT='10';process.env.MEDIA_FULL_DISCOUNT_PERCENT='15';process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic';
 const [{WebRepository},{WebCommerceRepository},{WebCommerceService},{WebVideoAccess},{MediaCommerceDecisionService},{MediaCommerceRepository},{PaymentProviderRegistry}]=await Promise.all([import('../src/web/repository.js'),import('../src/web/commerceRepository.js'),import('../src/web/commerce.js'),import('../src/web/videoAccess.js'),import('../src/mediaCommerceDecisionService.js'),import('../src/mediaCommerceRepository.js'),import('../src/payments/providers.js')]);
 const db=postgres(url,{max:8,prepare:false,onnotice:()=>{}});t.after(()=>db.end());
 const accounts=new WebRepository(db);let signed=0;
 const access=new WebVideoAccess(db,async()=>{signed++;return 'https://example.invalid/synthetic-signed-video';});
 const repo=new WebCommerceRepository(db,access);
 const decisions=new MediaCommerceDecisionService(new MediaCommerceRepository(db),{async createStarsInvoice(){throw new Error('Forbidden external call');}},null);
 const provider={id:'test_video',platforms:['web' as const],async create(input:any){return {external_id:'external-'+input.order_id,external_kind:'payment' as const,checkout_url:'https://example.invalid/pay',expires_at:null};},verifyNotification(raw:string){return JSON.parse(raw);}};
 const service=new WebCommerceService(repo,new PaymentProviderRegistry([provider]),decisions,accounts);
 const owner=async()=>{
  const userId=(await accounts.bootstrap({auth_user_id:randomUUID(),is_anonymous:false,display_name:'Video fixture',locale:'en'})).user_id;
  await accounts.confirmAge(userId);await accounts.acceptTerms(userId);
  const created=await accounts.createChat(userId,1,'roleplay',randomUUID());
  const [c]=await db`SELECT chat_id FROM public.chat_state WHERE chat_code=${created.chat.chat_code}`;const chatId=Number(c!.chat_id),scene='video-web-'+randomUUID();
  await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${chatId},${scene},'roleplay',1)`;
  await db`UPDATE public.chat_state SET active_scene_session_id=${scene},current_turn_no=0,scene_turn_no=0 WHERE chat_id=${chatId}`;
  await db`UPDATE app_private.web_operations SET status='completed' WHERE chat_id=${chatId}`;
  return {userId,chatId,scene,code:created.chat.chat_code};
 };
 const media=async(o:Awaited<ReturnType<typeof owner>>)=>{
  const id=randomUUID(),vid=randomUUID(),signature='synthetic_'+id;
  await db`INSERT INTO public.media_catalog(character_i,uuid,scene_hint,bucket_name,storage_path,status) VALUES(1,${id},${signature},'fixture',${id+'.png'},'ready')`;
  await db`INSERT INTO public.video_catalog(video_id,character_i,media_signature,storage_path,status) VALUES(${vid},1,${signature},${vid+'.mp4'},'ready')`;
  await service.prepareOffer(o.userId,o.code,{media_id:id,sku:'test_photo_video',media_signature:signature});
  const offer=await repo.getOffer(o.userId,o.code,id);assert.ok(offer);return {id,vid,signature,panel:offer.panel_id};
 };
 const buy=async(o:Awaited<ReturnType<typeof owner>>,sku:string,extra:Record<string,unknown>={})=>{
  const result=await service.purchase(o.userId,{client_message_id:randomUUID(),chat_code:o.code,sku,provider:'test_video',...extra});
  assert.ok('purchase_id' in result);return result as {purchase_id:string};
 };
 const paid=async(id:string)=>{
  const p=await repo.getById(id);assert.ok(p);
  return service.notification('test_video',JSON.stringify({provider:'test_video',order_id:id,external_payment_id:'external-'+id,external_invoice_id:null,status:'paid',price_amount:p.quote.amount,price_currency:'RUB',pay_amount:p.quote.amount,paid_amount:p.quote.amount}),undefined);
 };
 await t.test('paid one-video survives scene change, duplicate confirmation, and fixed panel delivery',async()=>{
  const o=await owner(),m=await media(o);const p=await buy(o,'test_video_unlock',{media_id:m.id});
  const next='video-web-'+randomUUID();await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${o.chatId},${next},'roleplay',1)`;
  await db`UPDATE public.chat_state SET active_scene_session_id=${next} WHERE chat_id=${o.chatId}`;
  await paid(p.purchase_id);await Promise.all([paid(p.purchase_id),paid(p.purchase_id)]);
  const stored=await repo.getById(p.purchase_id);assert.ok(stored?.quote.payload?.video_delivery_id);const id=String(stored.quote.payload.video_delivery_id);
  const rows=await db`SELECT * FROM app_private.video_deliveries WHERE payment_token=${stored.payment_token}`;assert.equal(rows.length,1);assert.equal(rows[0]!.video_id,m.vid);assert.equal(Number(rows[0]!.photo_message_id),m.panel);assert.equal(rows[0]!.scene_session_id,o.scene);
  assert.equal((await service.videoAccess(o.userId,id)).status,'queued');assert.equal(signed,0);
  await db`UPDATE app_private.video_deliveries SET eligible_at=clock_timestamp()-interval '1 second' WHERE delivery_id=${id}`;
  assert.equal((await service.videoAccess(o.userId,id)).status,'delivered');assert.equal(signed,1);
  assert.equal((await service.status(o.userId,p.purchase_id)).status,'fulfilled');
  await assert.rejects(service.videoAccess('u0000000',id));
 });
 await t.test('VideoPass buys only video for its current scene and expires on replacement',async()=>{
  const o=await owner(),m=await media(o);const p=await buy(o,'test_video_pass');await paid(p.purchase_id);
  const available=await service.videoAvailability(o.userId,o.code,m.id);assert.equal(available.video_pass_active,true);assert.equal(available.full_active,false);
  const [s]=await db`SELECT scene_access_unlocked_at FROM public.chat_scene_sessions WHERE scene_session_id=${o.scene}`;assert.equal(s!.scene_access_unlocked_at,null);
  const requested=await service.requestVideo(o.userId,o.code,m.id,'pass-request');const same=await service.requestVideo(o.userId,o.code,m.id,'pass-request');assert.equal(same.delivery_id,requested.delivery_id);
  const next='video-web-'+randomUUID();await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${o.chatId},${next},'roleplay',1)`;await db`UPDATE public.chat_state SET active_scene_session_id=${next} WHERE chat_id=${o.chatId}`;
  const [ctx]=await db`SELECT public.media_video_context(${o.chatId},${next},1,${m.signature},${m.panel}) AS value`;assert.equal(ctx!.value.video_pass_active,false);
 });
 await t.test('two separate paid checkouts for one panel persist a review marker without a second delivery',async()=>{
  const o=await owner(),m=await media(o);
  const first=await buy(o,'test_video_unlock',{media_id:m.id}),second=await buy(o,'test_video_pass',{media_id:m.id});
  await paid(first.purchase_id);await paid(second.purchase_id);
  const status=await service.status(o.userId,second.purchase_id);assert.equal(status.review_required,true);assert.equal(status.video_delivery_id,null);
  assert.equal((await repo.getById(second.purchase_id))!.error_code,'duplicate_payment_requires_review');
  assert.equal((await repo.pendingFulfillments()).some(p=>p.purchase_id===second.purchase_id),false);
  const [count]=await db`SELECT count(*)::integer AS n FROM app_private.video_deliveries WHERE chat_id=${o.chatId}`;assert.equal(count!.n,1);
  assert.equal((await service.videoAvailability(o.userId,o.code,m.id)).video_pass_active,true);
 });
 await t.test('Full upgrade replaces active Base with new 30 days and duplicate receipt does not extend',async()=>{
  const o=await owner();await db`UPDATE public.users SET subscription_sku='test_base_video',subscription_until=now()+interval '60 days' WHERE user_id=${o.userId}`;
  const p=await buy(o,'test_full_video',{subscription_change:'upgrade'});const quote=(await repo.getById(p.purchase_id))!.quote;assert.equal(quote.amount,'499');assert.equal(quote.amount_xtr,59);
  await paid(p.purchase_id);const [one]=await db`SELECT subscription_until,subscription_tier,extract(epoch FROM subscription_until-now())/86400 AS days FROM public.users WHERE user_id=${o.userId}`;
  assert.ok(Number(one!.days)>29.99&&Number(one!.days)<=30.001);assert.equal(one!.subscription_tier,'full');
  await paid(p.purchase_id);const [two]=await db`SELECT subscription_until FROM public.users WHERE user_id=${o.userId}`;assert.deepEqual(two!.subscription_until,one!.subscription_until);
  const m=await media(o);assert.equal((await service.videoAvailability(o.userId,o.code,m.id)).full_active,true);
 });
});
