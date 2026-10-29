import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {installTestEnv} from './testEnv.js';

test('Telegram video uses actual PostgreSQL payment snapshots and claim protocol',async t=>{
  const url=process.env.TEST_DATABASE_URL;if(!url)throw Error('TEST_DATABASE_URL required');
  const location=new URL(url);assert.ok(['localhost','127.0.0.1'].includes(location.hostname)&&location.pathname.includes('test'));
  process.env.DATABASE_URL=url;installTestEnv();process.env.MEDIA_VIDEO_ENABLED='true';process.env.SBP_ENABLED='false';
  const plan={amount_xtr:100,amount_rub:500,title:'Synthetic',description:'Neutral fixture',label:'Video',button_text:'Buy'};
  process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...plan,sku:'tg_base',days:14},{...plan,sku:'tg_full',tier:'full',days:30,amount_xtr:300}]);
  process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{...plan,sku:'tg_photo'}]);
  process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...plan,sku:'tg_video',feature_key:'video_unlock'},{...plan,sku:'tg_pass',feature_key:'video_pass'}]);
  const [{MediaCommerceDecisionService},{MediaCommerceRepository},{VideoCommerceRepository},{WebRepository}]=await Promise.all([
    import('../src/mediaCommerceDecisionService.js'),import('../src/mediaCommerceRepository.js'),import('../src/videoCommerce.js'),import('../src/web/repository.js')]);
  const db=postgres(url,{max:5,prepare:false,onnotice:()=>{}});t.after(()=>db.end());
  const accounts=new WebRepository(db),videos=new VideoCommerceRepository(db),repo=new MediaCommerceRepository(db);
  let signed=0;
  const service=new MediaCommerceDecisionService(repo,{async createStarsInvoice(input){return {invoice_link:`https://example.invalid/pay/${encodeURIComponent(input.payload)}`};}},null,videos,
    async()=>{signed++;return 'https://example.invalid/signed';});
  const fixture=async()=>{
    const userId=(await accounts.bootstrap({auth_user_id:randomUUID(),is_anonymous:false,display_name:'Telegram video test',locale:'en'})).user_id;
    await accounts.confirmAge(userId);await accounts.acceptTerms(userId);
    const created=await accounts.createChat(userId,1,'roleplay',randomUUID());
    const [c]=await db`SELECT chat_id FROM public.chat_state WHERE chat_code=${created.chat.chat_code}`;
    const chatId=Number(c!.chat_id),scene='tg-video-'+randomUUID(),signature='neutral_'+randomUUID(),video=randomUUID(),panel=123,telegram=777000;
    await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${chatId},${scene},'roleplay',1)`;
    await db`UPDATE public.chat_state SET active_scene_session_id=${scene},current_turn_no=0,scene_turn_no=0 WHERE chat_id=${chatId}`;
    await db`INSERT INTO public.video_catalog(video_id,character_i,media_signature,storage_path,status) VALUES(${video},1,${signature},${video+'.mp4'},'ready')`;
    const photo=randomUUID();
    const initial=await service.evaluate({interaction_mode:'video_context',chat_id:chatId,telegram_chat_id:telegram,scene_session_id:scene,media_signature:signature,panel_message_id:panel,current_uuid:photo});
    assert.ok(initial.video?.animate_callback_data,'Null character_i resolves canonical chat character');
    const markup={inline_keyboard:[[{text:'Next',callback_data:'legacy-next'}],[{text:'Video',callback_data:initial.video.animate_callback_data}]]};
    await videos.storePanel(chatId,panel,markup,signature,photo);
    return {userId,chatId,scene,signature,video,panel,telegram,photo,initial,markup};
  };
  const callback=async(f:Awaited<ReturnType<typeof fixture>>)=>service.evaluate({event_type:'callback_query.received',chat_id:f.chatId,telegram_chat_id:f.telegram,
    callback_data:f.initial.video!.animate_callback_data!,inbound_message_id:f.panel,raw_update:{callback_query:{message:{reply_markup:f.markup}}}});
  const pay=async(chatId:number,token:string)=>{
    const loaded=await repo.loadInvoiceToken(token,chatId);assert.ok(loaded);
    return service.evaluate({event_type:'payment.success.received',chat_id:chatId,invoice_payload:token,payment_currency:'XTR',payment_total_amount:loaded.amount!,telegram_payment_charge_id:'fixture-charge-'+token,provider_payment_charge_id:'fixture-provider-'+token});
  };
  await t.test('paid unlock freezes original scene/video/panel and duplicate confirmation produces one delivery',async()=>{
    const f=await fixture();const options=await callback(f);assert.equal(options.operation,'video_ui_ready');
    const token=options.video!.unlock_payment_options![0]!.token;
    const [snapshot]=await db`SELECT payload_json FROM public.interaction_tokens WHERE token=${token}`;
    assert.equal(snapshot!.payload_json.video_id,f.video);assert.equal(snapshot!.payload_json.character_i,1);
    const next='tg-video-'+randomUUID();await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${f.chatId},${next},'roleplay',1)`;
    await db`UPDATE public.chat_state SET active_scene_session_id=${next} WHERE chat_id=${f.chatId}`;
    const first=await pay(f.chatId,token);assert.equal(first.operation,'video_delivery_required');
    const again=await pay(f.chatId,token);assert.equal(again.delivery_id,first.delivery_id);assert.equal(first.target_message_id,f.panel);
    const [count]=await db`SELECT count(*)::int AS n FROM app_private.video_deliveries WHERE payment_token=${token}`;assert.equal(count!.n,1);
    assert.equal((await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:first.delivery_id})).operation,'noop');assert.equal(signed,0);
    await db`UPDATE app_private.video_deliveries SET eligible_at=clock_timestamp()-interval '1 second' WHERE delivery_id=${first.delivery_id!}`;
    const claims=await Promise.all([service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:first.delivery_id}),service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:first.delivery_id})]);
    assert.equal(claims.filter(row=>row.operation==='video_delivery_claimed').length,1);assert.equal(signed,1);
    const claim=claims.find(row=>row.claim_token)!;
    await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:first.delivery_id,claim_token:claim.claim_token,delivery_success:false,retryable:true,delivery_error:'telegram_explicit_rejection'});
    const retry=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:first.delivery_id});assert.equal(retry.operation,'video_delivery_claimed');
    const latest={inline_keyboard:[[{text:'Latest',callback_data:'latest-next'}],[{text:'Video',callback_data:f.initial.video!.animate_callback_data}]]};
    await videos.storePanel(f.chatId,f.panel,latest,'new-signature',randomUUID());
    const done=await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:first.delivery_id,claim_token:retry.claim_token,delivery_success:true,sent_message_id:500});
    assert.equal(done.delivered,true);assert.deepEqual(done.reply_markup,latest);assert.ok(done.video_control_tokens?.includes(f.initial.video!.animate_callback_data!));
    assert.equal((await pay(f.chatId,token)).reason,'payment_already_fulfilled');
  });
  await t.test('Full entitlement requests do not create invoices and one panel stays consumed',async()=>{
    const f=await fixture();await db`UPDATE public.users SET subscription_sku='tg_full',subscription_until=now()+interval '30 days',subscription_tier='full',subscription_tier_sku='tg_full' WHERE user_id=${f.userId}`;
    const result=await callback(f);assert.equal(result.operation,'video_delivery_required');
    const [count]=await db`SELECT count(*)::int AS n FROM public.interaction_tokens WHERE chat_id=${f.chatId} AND kind='invoice_payload'`;assert.equal(count!.n,0);
    await db`UPDATE app_private.video_deliveries SET eligible_at=clock_timestamp()-interval '1 second' WHERE delivery_id=${result.delivery_id!}`;
    const claimed=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:result.delivery_id});
    await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:result.delivery_id,claim_token:claimed.claim_token,delivery_success:true,sent_message_id:501});
    const context=await service.evaluate({interaction_mode:'video_context',chat_id:f.chatId,telegram_chat_id:f.telegram,scene_session_id:f.scene,media_signature:f.signature,panel_message_id:f.panel});
    assert.equal(context.video?.consumed,true);assert.equal(context.video?.animate_callback_data,undefined);
  });
});
