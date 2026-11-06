import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import postgres from 'postgres';
import {assertWebContract} from './support/webContract.js';
import {installTestEnv,testTelegramUxCopy} from './testEnv.js';

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
 const decisions=new MediaCommerceDecisionService(new MediaCommerceRepository(db),{async createStarsInvoice(){throw new Error('Forbidden external call');}},null,undefined,undefined,{async getTelegramCopy(){return testTelegramUxCopy;}});
 const provider={id:'test_video',platforms:['web' as const],async create(input:any){return {external_id:'external-'+input.order_id,external_kind:'payment' as const,checkout_url:'https://example.invalid/pay',expires_at:null};},verifyNotification(raw:string){return JSON.parse(raw);}};
 const service=new WebCommerceService(repo,new PaymentProviderRegistry([provider]),decisions,accounts);
 const owner=async()=>{
  const userId=(await accounts.bootstrap({auth_user_id:randomUUID(),is_anonymous:false,display_name:'Video fixture',locale:'en'})).user_id;
  await accounts.updateMe(userId,{language:'en'});
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
  await db`INSERT INTO public.video_catalog(video_id,character_i,media_signature,source_photo_uuid,storage_path,status) VALUES(${vid},1,${signature},${id},${vid+'.mp4'},'ready')`;
  await service.prepareOffer(o.userId,o.code,{media_id:id,sku:'test_photo_video',media_signature:signature});
  const offer=await repo.getOffer(o.userId,o.code,id);assert.ok(offer);
  const opened=await service.unlock(o.userId,o.code,id,{client_message_id:randomUUID()});assert.equal('unlocked' in opened&&opened.unlocked,true);
  return {id,vid,signature,panel:offer.panel_id};
 };
 const buy=async(o:Awaited<ReturnType<typeof owner>>,sku:string,extra:Record<string,unknown>={})=>{
  const result=await service.purchase(o.userId,{client_message_id:randomUUID(),chat_code:o.code,sku,provider:'test_video',...extra});
  assert.ok('purchase_id' in result);return result as {purchase_id:string};
 };
 const paid=async(id:string)=>{
  const p=await repo.getById(id);assert.ok(p);
  return service.notification('test_video',JSON.stringify({provider:'test_video',order_id:id,external_payment_id:'external-'+id,external_invoice_id:null,status:'paid',price_amount:p.quote.amount,price_currency:'RUB',pay_amount:p.quote.amount,paid_amount:p.quote.amount}),undefined);
 };
 await t.test('zero-chat subscription checkout, two-tab recovery aliases, renew and Full upgrade use one account entitlement',async()=>{
  const userId=(await accounts.bootstrap({auth_user_id:randomUUID(),is_anonymous:false,display_name:'Account subscription fixture',locale:'en'})).user_id;
  await accounts.updateMe(userId,{language:'en'});await accounts.confirmAge(userId);await accounts.acceptTerms(userId);
  const catalog=await service.catalog(userId);assertWebContract('Catalog',catalog);assert.equal(catalog.products.find(p=>p.sku==='test_base_video')!.requires_chat,false);
  assert.equal(catalog.products.find(p=>p.sku==='test_video_pass')!.requires_chat,true);
  await assert.rejects(service.purchase(userId,{client_message_id:randomUUID(),sku:'test_video_pass',provider:'test_video'}),{code:'chat_required'});
  const left={client_message_id:randomUUID(),sku:'test_base_video',provider:'test_video'},right={...left,client_message_id:randomUUID()};
  const purchases=await Promise.all([service.purchase(userId,left),service.purchase(userId,right)]);
  assert.ok('purchase_id' in purchases[0]!&&'purchase_id' in purchases[1]!);
  assertWebContract('Purchase',purchases[0]);const id=purchases[0].purchase_id;assert.equal(purchases[1].purchase_id,id);
  const purchase=await repo.getById(id);assert.equal(purchase!.chat_id,null);assert.equal(purchase!.quote.chat_code,null);
  const [token]=await db`SELECT chat_id,payload_json FROM public.interaction_tokens WHERE token=${purchase!.payment_token}`;
  assert.equal(token!.chat_id,null);assert.equal(token!.payload_json.user_id,userId);
  await Promise.all([paid(id),paid(id)]);
  const first=await service.entitlements(userId);assertWebContract('Entitlements',first);assert.equal(first.subscription_active,true);
  assert.equal((await service.purchase(userId,right) as {purchase_id:string}).purchase_id,id);
  assert.equal((await service.entitlements(userId)).subscription_until,first.subscription_until);
  // Emulate a request whose first lookup preceded the other tab's commit.
  const staleLookup=await repo.createOrGet(userId,right.client_message_id,purchase!.fingerprint,purchase!.quote,purchase!.provider);assert.equal(staleLookup.purchase.purchase_id,id);assert.equal(staleLookup.created,false);
  await assert.rejects(service.purchase(userId,{...right,sku:'test_full_video'}),{code:'idempotency_conflict'});
  const renew=await service.purchase(userId,{...left,client_message_id:randomUUID()});assert.ok('purchase_id' in renew);assert.notEqual(renew.purchase_id,id);await paid(renew.purchase_id);
  const renewed=await service.entitlements(userId);assert.ok(Date.parse(renewed.subscription_until!)-Date.parse(first.subscription_until!)>6.99*86400000);
  const upgrade=await service.purchase(userId,{client_message_id:randomUUID(),sku:'test_full_video',provider:'test_video',subscription_change:'upgrade'});assert.ok('purchase_id' in upgrade);await paid(upgrade.purchase_id);
  const full=await service.entitlements(userId);assert.equal(full.full_active,true);assert.ok(Date.parse(full.subscription_until!)-Date.now()>29.99*86400000);
  const [count]=await db`SELECT count(*) AS n FROM public.chat_state WHERE user_id=${userId}`;assert.equal(Number(count!.n),0);
 });
 await t.test('photo panels preserve native ordering, five-photo limit, locked offers, entitlements and idempotent navigation',async()=>{
  const o=await owner(),foreign=await owner(),signature='panel-'+randomUUID(),common=new MediaCommerceRepository(db);
  const ids=Array.from({length:6},()=>randomUUID());
  for(const id of ids)await db`INSERT INTO public.media_catalog(character_i,uuid,scene_hint,bucket_name,storage_path,status) VALUES(1,${id},${signature},'fixture',${id+'.png'},'ready')`;
  const input={chat_id:o.chatId,scene_session_id:o.scene,turn_no:0,scene_turn_no:0,media_signature:signature,current_uuid:null,target_message_id:1,base_price_xtr:10,action_kind:'photo_request',requested_action:'photo_request',invoice_token:null,force_deliver_after_payment:false,paid_access_mode:null,callback_valid:true,panel_text:null,panel_entities_json:[]};
  const native=await common.loadMediaContext(input),anchor=(native.next_unseen_json as {uuid:string}).uuid;
  await service.prepareOffer(o.userId,o.code,{media_id:anchor,sku:'test_photo_video',media_signature:signature});
  const panel=(await repo.getOffer(o.userId,o.code,anchor))!.panel_id;
  const initial=await service.photoPanel(o.userId,o.code,anchor);assertWebContract('PhotoPanel',initial);assert.equal(initial.photo_url,null);assert.equal(initial.unlocked,false);
  await assert.rejects(service.photoPanel(foreign.userId,o.code,anchor),{code:'chat_not_found'});
  await assert.rejects(service.photoPanel(o.userId,o.code,anchor,ids.find(id=>id!==anchor)),{code:'media_not_unlocked'});
  await service.unlock(o.userId,o.code,anchor,{client_message_id:randomUUID()});
  const unlocked=[anchor];
  for(let index=1;index<5;index++){
   const request={client_message_id:randomUUID(),action:'photo_regen' as const,current_media_id:unlocked.at(-1)!};
   const more=await service.photoPanelAction(o.userId,o.code,anchor,request);assert.ok(more.offer);assert.equal('photo_url' in more.offer,false);
   assert.deepEqual(await service.photoPanelAction(o.userId,o.code,anchor,request),more);
   const next=more.offer.media_id;assert.equal(unlocked.includes(next),false);
   assert.equal((await repo.getOffer(o.userId,o.code,next))!.panel_id,panel);
   assert.equal((await service.photoPanel(o.userId,o.code,next)).photo_url,null);
   if(index===3){
    await assert.rejects(service.unlock(o.userId,o.code,next,{client_message_id:randomUUID()}),{code:'payment_required'});
    const purchase=await service.unlock(o.userId,o.code,next,{client_message_id:randomUUID(),provider:'test_video'});assert.ok('purchase_id' in purchase);await paid(purchase.purchase_id);
   }else{
    if(index===4)await db`UPDATE public.users SET subscription_sku='test_base_video',subscription_until=now()+interval '1 day' WHERE user_id=${o.userId}`;
    const access=await service.unlock(o.userId,o.code,next,{client_message_id:randomUUID()});assert.equal('unlocked' in access&&access.unlocked,true);
   }
   unlocked.push(next);
  }
  const ready=await service.photoPanel(o.userId,o.code,anchor,unlocked.at(-1));assert.equal(ready.actions.more,false);assert.equal(ready.actions.next,true);
  await assert.rejects(service.photoPanelAction(o.userId,o.code,anchor,{client_message_id:randomUUID(),action:'photo_regen'}),{code:'photo_unavailable'});
  const context=await common.loadMediaContext({...input,target_message_id:panel});
  const ordered=(context.unlocked_items_json as {uuid:string}[]).map(item=>item.uuid);assert.equal(ordered.length,5);
  await db`UPDATE public.users SET subscription_until=now()-interval '1 day' WHERE user_id=${o.userId}`;
  const request={client_message_id:randomUUID(),action:'photo_prev' as const,current_media_id:ordered[0]!};
  const previous=await service.photoPanelAction(o.userId,o.code,anchor,request);assert.equal(previous.media_id,ordered.at(-1));assert.ok(previous.photo_url);
  assert.deepEqual(await service.photoPanelAction(o.userId,o.code,anchor,request),previous);
  await assert.rejects(service.photoPanelAction(o.userId,o.code,anchor,{...request,action:'photo_next'}),{code:'idempotency_conflict'});
  assert.equal((await service.photoPanelAction(o.userId,o.code,anchor,{client_message_id:randomUUID(),action:'photo_next',current_media_id:ordered.at(-1)!})).media_id,ordered[0]);
  assert.ok((await service.gallery(o.userId,o.code)).media.every(item=>'panel_media_id' in item));
  const [count]=await db`SELECT count(*) AS n FROM public.chat_messages WHERE chat_id=${o.chatId} AND event_type='media.photo.viewed.nav'`;assert.equal(Number(count!.n),2);
  await db`UPDATE public.chat_state SET active_scene_session_id=NULL WHERE chat_id=${o.chatId}`;
  assert.equal((await service.photoPanel(o.userId,o.code,anchor)).actions.more,false);
  assert.equal((await service.photoPanelAction(o.userId,o.code,anchor,{client_message_id:randomUUID(),action:'photo_next',current_media_id:ordered[0]!})).media_id,ordered[1]);
  await assert.rejects(service.photoPanelAction(o.userId,o.code,anchor,{client_message_id:randomUUID(),action:'photo_regen'}),{code:'stale_scene'});
 });
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
  const transcript=await accounts.history(o.userId,o.code);assert.equal(transcript.messages.filter(message=>message.id==='v:'+id).length,0);
  assert.equal((await service.gallery(o.userId,o.code)).video_deliveries?.some(delivery=>delivery.delivery_id===id),true);
  const [attempts]=await db`SELECT attempts FROM app_private.video_deliveries WHERE delivery_id=${id}`;
  await db`UPDATE app_private.video_deliveries SET delivered_at=clock_timestamp()-interval '35 days' WHERE delivery_id=${id}`;
  await db`UPDATE public.users SET subscription_until=now()-interval '1 day' WHERE user_id=${o.userId}`;
  assert.equal((await service.videoAccess(o.userId,id)).status,'delivered');
  const [replayed]=await db`SELECT attempts FROM app_private.video_deliveries WHERE delivery_id=${id}`;assert.equal(replayed!.attempts,attempts!.attempts);
  assert.equal((await new WebRepository(db).history(o.userId,o.code)).messages.filter(message=>message.id==='v:'+id).length,0);

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
 await t.test('mixed text, delivered photo and video history paginates without gaps at PostgreSQL microsecond precision',async()=>{
  const o=await owner(),m=await media(o),p=await buy(o,'test_video_unlock',{media_id:m.id});await paid(p.purchase_id);
  const stored=await repo.getById(p.purchase_id),delivery=String(stored!.quote.payload!.video_delivery_id);
  await db`UPDATE app_private.video_deliveries SET eligible_at=now()-interval '1 second' WHERE delivery_id=${delivery}`;await service.videoAccess(o.userId,delivery);
  await db`UPDATE app_private.video_deliveries SET requested_photo_uuid=NULL WHERE delivery_id=${delivery}`;
  const time='2026-11-03T12:00:00.123456Z';
  const operation=await accounts.enqueue(o.userId,o.code,'message','repeated-hello','Hello');
  await db`INSERT INTO public.chat_messages(chat_id,scene_session_id,turn_no,seq_in_turn,sender_type,direction,source,message_text,source_event_id,created_at)
   VALUES(${o.chatId},${o.scene},1,1,'user','inbound','web','Hello',${operation.event_id},${time}::text::timestamptz)`;
  await db`INSERT INTO public.chat_messages(chat_id,scene_session_id,turn_no,seq_in_turn,sender_type,direction,source,message_type,event_type,message_text,payload_json,created_at)
   VALUES(${o.chatId},${o.scene},1,2,'assistant','outbound','web','photo','media.photo.unlocked.free','A photo',${db.json({uuid:m.id,panel_message_id:m.panel})},${time}::text::timestamptz+interval '1 microsecond')`;
  await db`UPDATE app_private.video_deliveries SET delivered_at=${time}::text::timestamptz+interval '2 microseconds' WHERE delivery_id=${delivery}`;
  const complete=await accounts.history(o.userId,o.code);assert.deepEqual(complete.messages.slice(0,3).map(message=>message.media_kind??'text'),['text','photo','video']);
  assert.deepEqual(complete.messages.slice(0,3).map(message=>message.created_at),['2026-11-03T12:00:00.123456Z','2026-11-03T12:00:00.123457Z','2026-11-03T12:00:00.123458Z']);
  assert.ok(complete.messages[1]!.photo_url?.includes(m.id));assert.equal(complete.messages[1]!.text,'A photo');assert.equal(complete.messages[0]!.client_message_id,'repeated-hello');
  const ids:string[]=[];let before:string|undefined;
  do {const page=await accounts.history(o.userId,o.code,before,1);ids.push(...page.messages.map(message=>message.id));before=page.next_before??undefined;}while(before);
  assert.equal(new Set(ids).size,complete.messages.length,JSON.stringify({ids,expected:complete.messages.map(message=>message.id)}));assert.deepEqual(ids.reverse(),complete.messages.map(message=>message.id));
  await assert.rejects(accounts.history('u0000000',o.code),{code:'chat_not_found'});
 });
 await t.test('EN NOWPayments invoice, signed confirmation and duplicate IPN fulfill the same paid delivery once',async()=>{
  const [{NowPaymentsProvider,canonicalNowPaymentsJson},{LocalizationService},{LocalizationRepository}]=await Promise.all([import('../src/payments/nowpayments.js'),import('../src/localization.js'),import('../src/localizationRepository.js')]);
  const o=await owner(),m=await media(o);let creations=0;
  const ipnSecret='synthetic-ipn-secret',invoiceId=String(Date.now())+String(Math.floor(Math.random()*1000)).padStart(3,'0'),paymentId=invoiceId+'1';
  const provider=new NowPaymentsProvider({apiKey:'synthetic-key',ipnSecret,callbackUrl:'https://gateway.example/web/commerce/nowpayments/ipn',successUrl:'https://frontend.example',cancelUrl:'https://frontend.example',fetchImpl:async(url,init)=>{
   assert.equal(String(url),'https://api.nowpayments.io/v1/invoice');creations++;
   const body=JSON.parse(String(init?.body));return Response.json({id:invoiceId,order_id:body.order_id,price_amount:String(body.price_amount),price_currency:body.price_currency,invoice_url:'https://nowpayments.io/payment/?iid='+invoiceId});
  }});
  const localization=new LocalizationService(new LocalizationRepository(db),{characterGalleryOrder:[],characterVoteUrl:''});
  const commerce=new WebCommerceService(repo,new PaymentProviderRegistry([provider]),decisions,accounts,localization);
  const catalog=await commerce.catalog(o.userId,o.code);assert.deepEqual(catalog.providers,['nowpayments']);
  const input={client_message_id:randomUUID(),chat_code:o.code,sku:'test_video_unlock',media_id:m.id,provider:'nowpayments'};
  const first=await commerce.purchase(o.userId,input);assert.ok('purchase_id' in first);const id=first.purchase_id;
  assert.equal((await commerce.status(o.userId,id)).status,'pending');assert.equal((await commerce.purchase(o.userId,input) as {purchase_id:string}).purchase_id,id);assert.equal(creations,1);
  const quote=(await repo.getById(id))!.quote;
  const notification={order_id:id,invoice_id:invoiceId,payment_id:paymentId,payment_status:'finished',price_amount:quote.amount,price_currency:'rub',pay_amount:'0.001',actually_paid:'0.001',pay_currency:'btc'};
  const raw=JSON.stringify(notification),signature=createHmac('sha512',ipnSecret).update(canonicalNowPaymentsJson(notification)).digest('hex');
  await commerce.notification('nowpayments',raw,signature);await commerce.notification('nowpayments',raw,signature);
  const stored=await repo.getById(id),delivery=String(stored!.quote.payload!.video_delivery_id);
  assert.equal(stored!.external_invoice_id,invoiceId);assert.equal(stored!.external_payment_id,paymentId);
  const [count]=await db`SELECT count(*)::int AS count FROM app_private.video_deliveries WHERE payment_token=${stored!.payment_token}`;assert.equal(count!.count,1);
  await db`UPDATE app_private.video_deliveries SET eligible_at=now()-interval '1 second' WHERE delivery_id=${delivery}`;await commerce.videoAccess(o.userId,delivery);
  assert.equal((await commerce.status(o.userId,id)).status,'fulfilled');assert.equal(creations,1);
  await assert.rejects(commerce.notification('nowpayments',raw,'0'.repeat(128)),{code:'invalid_ipn_signature'});
 });

});
