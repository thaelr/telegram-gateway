import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {installTestEnv,testTelegramUxCopy} from './testEnv.js';

test('Telegram video uses actual PostgreSQL payment snapshots and claim protocol',async t=>{
  const url=process.env.TEST_DATABASE_URL;if(!url)throw Error('TEST_DATABASE_URL required');
  const location=new URL(url);assert.ok(['localhost','127.0.0.1'].includes(location.hostname)&&location.pathname.includes('test'));
  process.env.DATABASE_URL=url;installTestEnv();process.env.MEDIA_VIDEO_ENABLED='true';process.env.SBP_ENABLED='false';
  const plan={amount_xtr:100,amount_rub:500,title:'Synthetic',description:'Neutral fixture',label:'Video',button_text:'Buy'};
  process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...plan,sku:'tg_base',days:14},{...plan,sku:'tg_full',tier:'full',days:30,amount_xtr:300,amount_rub:1500}]);
  process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{...plan,sku:'tg_photo'}]);
  process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...plan,sku:'tg_scene',feature_key:'scene_unlock'},{...plan,sku:'tg_video',feature_key:'video_unlock'},{...plan,sku:'tg_pass',feature_key:'video_pass',scene_unlock_upgrade:{amount_xtr:79,amount_rub:333,discount_percent:50}}]);
  const [{MediaCommerceDecisionService},{MediaCommerceRepository},{VideoCommerceRepository},{WebRepository}]=await Promise.all([
    import('../src/mediaCommerceDecisionService.js'),import('../src/mediaCommerceRepository.js'),import('../src/videoCommerce.js'),import('../src/web/repository.js')]);
  const db=postgres(url,{max:5,prepare:false,onnotice:()=>{}});t.after(()=>db.end());
  const accounts=new WebRepository(db),videos=new VideoCommerceRepository(db),repo=new MediaCommerceRepository(db);
  let signed=0;
  const service=new MediaCommerceDecisionService(repo,{async createStarsInvoice(input){return {invoice_link:`https://example.invalid/pay/${encodeURIComponent(input.payload)}`};}},{async createPayment(input){return {external_payment_id:'fixture-'+input.token,checkout_url:'https://provider.invalid/pay/'+input.token,provider_expires_at:null};}},videos,
    async()=>{signed++;return 'https://example.invalid/signed';},{async getTelegramCopy(){return testTelegramUxCopy;}});
  const fixture=async(firstReceipt=false)=>{
    const userId=(await accounts.bootstrap({auth_user_id:randomUUID(),is_anonymous:false,display_name:'Telegram video test',locale:'en'})).user_id;
    await accounts.updateMe(userId,{language:'en'});
    await accounts.confirmAge(userId);await accounts.acceptTerms(userId);
    const created=await accounts.createChat(userId,1,'roleplay',randomUUID());
    const [c]=await db`SELECT chat_id FROM public.chat_state WHERE chat_code=${created.chat.chat_code}`;
    const chatId=Number(c!.chat_id),scene='tg-video-'+randomUUID(),loc='fixture'+randomUUID().replaceAll('-',''),signature=loc+'_close_sitting_dress_front',video=randomUUID(),panel=123,telegram=777000;
    await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${chatId},${scene},'roleplay',1)`;
    await db`UPDATE public.chat_state SET active_scene_session_id=${scene},current_turn_no=0,scene_turn_no=0 WHERE chat_id=${chatId}`;
    await db`UPDATE public.chat_scene_sessions SET entry_scene_start_hint_json=${db.json({location:loc,pose:'sitting',clothes:'dress',partner_position:'front'})} WHERE chat_id=${chatId} AND scene_session_id=${scene}`;
    const photo=randomUUID();
    await db`INSERT INTO public.media_catalog(character_i,uuid,scene_hint,bucket_name,storage_path,status) VALUES(1,${photo},${signature},'media_bucket',${photo+'.jpg'},'ready')`;
    await db`INSERT INTO public.video_catalog(video_id,character_i,media_signature,source_photo_uuid,storage_path,status) VALUES(${video},1,${signature},${photo},${video+'.mp4'},'ready')`;
    if(!firstReceipt)await videos.storePanel(chatId,panel,{inline_keyboard:[]},signature,photo);
    const initial=await service.evaluate({interaction_mode:'video_context',chat_id:chatId,telegram_chat_id:telegram,scene_session_id:scene,media_signature:signature,panel_message_id:panel,current_uuid:photo});
    if(firstReceipt)assert.equal(initial.video?.available,false);
    else assert.ok(initial.video?.animate_callback_data,'Null character_i resolves canonical chat character');
    const markup={inline_keyboard:[[{text:'Next',callback_data:'legacy-next'}],[{text:'Video',callback_data:initial.video.animate_callback_data}]]};
    if(!firstReceipt)await videos.storePanel(chatId,panel,markup,signature,photo);
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
    const selected=await service.evaluate({event_type:'callback_query.received',chat_id:f.chatId,telegram_chat_id:f.telegram,inbound_message_id:f.panel,
      callback_data:options.commerce_ui!.products.find(p=>p.feature_key==='video_unlock')!.callback_data});
    const token=selected.commerce_ui!.payment_options![0]!.token;
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
    const done=await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:first.delivery_id,claim_token:retry.claim_token,delivery_success:true,sent_message_id:f.panel});
    assert.equal(done.delivered,true);assert.deepEqual(done.reply_markup,latest);assert.ok(done.video_control_tokens?.includes(f.initial.video!.animate_callback_data!));
    const viewToken=done.video_panel_video_callback_data!;
    assert.ok(viewToken);
    const payOffer=f.initial.video!.chat_offer_callback_data!;
    await db`UPDATE public.interaction_tokens SET created_at=now()-interval '10 days',expires_at=CASE
      WHEN token=${payOffer} THEN now()-interval '3 days' ELSE expires_at END WHERE token IN (${viewToken},${payOffer})`;
    const [navigation]=await db`SELECT expires_at FROM public.interaction_tokens WHERE token=${viewToken}`;
    assert.equal(navigation!.expires_at,null);
    const view=(button:string,sender=f.telegram)=>service.evaluate({interaction_mode:'callback',event_type:'callback_query.received',
      chat_id:f.chatId,telegram_chat_id:sender,inbound_message_id:f.panel,callback_data:button,
      raw_update:{callback_query:{from:{id:sender},message:{message_id:f.panel,chat:{id:sender}}}}});
    assert.equal((await view(viewToken)).operation,'video_panel_media_ready');
    assert.equal((await view(viewToken,f.telegram+1)).operation,'noop');
    assert.equal((await view(payOffer)).operation,'noop');
    assert.equal((await pay(f.chatId,token)).reason,'payment_already_fulfilled');
  });
  await t.test('first photo receipt makes one-video and pass actions available on the original Scene Unlock panel',async()=>{
    const f=await fixture(true);
    const menu=await service.evaluate({interaction_mode:'subscription_offer',idempotency_key:'receipt-menu-'+randomUUID(),chat_id:f.chatId,
      scene_session_id:f.scene,subscription_offer_reason:'subscription_command'});
    const scene=menu.token_rows!.find(row=>row.action_kind==='free_scene_unlock')!.token;
    const markup={inline_keyboard:[[{text:'Scene Unlock',callback_data:scene}]]};
    const input={interaction_mode:'finalize_photo_event' as const,chat_id:f.chatId,telegram_chat_id:f.telegram,scene_session_id:f.scene,
      turn_no:0,scene_turn_no:0,panel_message_id:f.panel,selected_uuid:f.photo,current_uuid:f.photo,media_signature:f.signature,
      access_mode:'free',log_event_type:'media.photo.unlocked.free',action_kind:'photo_request',current_reply_markup:markup};
    const ready=await service.evaluate(input);
    assert.equal(ready.video_panel_reconcile,true);assert.equal(ready.target_message_id,f.panel);assert.deepEqual(ready.reply_markup,markup);
    assert.ok(ready.video?.chat_offer_callback_data);assert.ok(ready.video?.animate_callback_data);
    const shown={inline_keyboard:[...markup.inline_keyboard,[{text:'VideoPass',callback_data:ready.video.chat_offer_callback_data}],
      [{text:'Animate',callback_data:ready.video.animate_callback_data}]]};
    const repeated=await service.evaluate({...input,current_reply_markup:shown});
    assert.equal(repeated.video_panel_reconcile,undefined);
    const unlock=await service.evaluate({event_type:'callback_query.received',chat_id:f.chatId,telegram_chat_id:f.telegram,
      callback_data:ready.video.animate_callback_data,inbound_message_id:f.panel,raw_update:{callback_query:{message:{reply_markup:shown}}}});
    assert.equal(unlock.target_message_id,f.panel);assert.deepEqual(unlock.commerce_ui?.products.map(p=>p.feature_key),['video_unlock','video_pass']);
    assert.ok(!unlock.video_control_tokens?.includes(scene));
  });
  await t.test('Telegram pass-only upgrade uses paid scene proof and preserves the original Stars quote',async()=>{
    const f=await fixture(),token='test-scene-'+randomUUID();
    await db`INSERT INTO public.interaction_tokens(token,kind,chat_id,scene_session_id,sku,action_kind,payload_json,status,payment_source,amount,currency,amount_xtr,paid_at)
      VALUES(${token},'invoice_payload',${f.chatId},${f.scene},'tg_scene','feature_payment','{"feature_key":"scene_unlock","duration_days":7}','paid','stars',100,'XTR',100,now())`;
    assert.equal(await repo.activateSceneAccess({payment_token:token,chat_id:f.chatId,scene_session_id:f.scene,scene_access_sku:'tg_scene'}),1);
    const reveal=await service.evaluate({event_type:'callback_query.received',chat_id:f.chatId,telegram_chat_id:f.telegram,
      callback_data:f.initial.video!.chat_offer_callback_data!,inbound_message_id:f.panel,raw_update:{callback_query:{message:{reply_markup:f.markup}}}});
    const payment=await service.evaluate({event_type:'callback_query.received',chat_id:f.chatId,telegram_chat_id:f.telegram,inbound_message_id:f.panel,
      callback_data:reveal.commerce_ui!.products.find(p=>p.feature_key==='video_pass')!.callback_data});
    const option=payment.commerce_ui!.payment_options![0]!;
    const [snapshot]=await db`SELECT amount,payload_json FROM public.interaction_tokens WHERE token=${option.token}`;
    assert.equal(snapshot!.amount,40);assert.equal(snapshot!.payload_json.original_amount,79);assert.equal(snapshot!.payload_json.purchase_variant,'scene_unlock_upgrade');
    assert.equal(snapshot!.payload_json.paid_scene_unlock_token,token);assert.equal(snapshot!.payload_json.user_id,f.userId);
    assert.equal(snapshot!.payload_json.video_id,null);assert.equal(snapshot!.payload_json.pass_only,true);
    const checked=await service.evaluate({event_type:'payment.pre_checkout.received',chat_id:f.chatId,invoice_payload:option.token,
      pre_checkout_query_id:'pre-upgrade',payment_currency:'XTR',payment_total_amount:option.amount});
    assert.equal(checked.precheckout_ok,true,checked.reason??undefined);
    const {config}=await import('../src/config.js');
    const pass=config.MEDIA_ACTION_PLANS_JSON.find(item=>item.feature_key==='video_pass')!;
    const previous=pass.scene_unlock_upgrade,days=config.SCENE_ACCESS_DAYS;delete pass.scene_unlock_upgrade;
    config.SCENE_ACCESS_DAYS=2;
    try{
      assert.equal((await pay(f.chatId,option.token)).operation,'video_pass_activated');
      assert.equal((await pay(f.chatId,option.token)).reason,'payment_already_fulfilled');
    }finally{pass.scene_unlock_upgrade=previous;config.SCENE_ACCESS_DAYS=days;}
    const [expiry]=await db`SELECT extract(epoch FROM (e.video_pass_valid_until-v.created_at))::int AS seconds
      FROM app_private.video_scene_passes v CROSS JOIN LATERAL app_private.scene_entitlements(v.chat_id,v.scene_session_id) e
      WHERE v.chat_id=${f.chatId} AND v.scene_session_id=${f.scene}`;
    assert.equal(expiry!.seconds,7*24*3600);
    const [scene]=await db`SELECT scene_access_payment_token FROM public.chat_scene_sessions WHERE chat_id=${f.chatId} AND scene_session_id=${f.scene}`;
    assert.equal(scene!.scene_access_payment_token,token);
    const [d]=await db`SELECT count(*)::int AS n FROM app_private.video_deliveries WHERE payment_token=${option.token}`;assert.equal(d!.n,0);
  });
  await t.test('Full entitlement requests do not create invoices and one panel stays consumed',async()=>{
    const f=await fixture();await db`UPDATE public.users SET subscription_sku='tg_full',subscription_until=now()+interval '30 days',subscription_tier='full',subscription_tier_sku='tg_full' WHERE user_id=${f.userId}`;
    const result=await callback(f);assert.equal(result.operation,'video_delivery_required');
    const [count]=await db`SELECT count(*)::int AS n FROM public.interaction_tokens WHERE chat_id=${f.chatId} AND kind='invoice_payload'`;assert.equal(count!.n,0);
    await db`UPDATE app_private.video_deliveries SET eligible_at=clock_timestamp()-interval '1 second' WHERE delivery_id=${result.delivery_id!}`;
    const claimed=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:result.delivery_id});
    await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:result.delivery_id,claim_token:claimed.claim_token,delivery_success:true,sent_message_id:f.panel});
    const context=await service.evaluate({interaction_mode:'video_context',chat_id:f.chatId,telegram_chat_id:f.telegram,scene_session_id:f.scene,media_signature:f.signature,panel_message_id:f.panel});
    assert.equal(context.video?.consumed,true);assert.equal(context.video?.animate_callback_data,undefined);
  });
  await t.test('PAY-01/02/03: every configured commerce product uses the permitted RU or EN methods and immutable provider amounts',async(st)=>{
    const {config}=await import('../src/config.js');
    const origSbp=config.SBP_ENABLED,origUrl=config.GATEWAY_PUBLIC_URL;
    config.SBP_ENABLED=true;config.GATEWAY_PUBLIC_URL='https://merchant.invalid';
    st.after(()=>{config.SBP_ENABLED=origSbp;config.GATEWAY_PUBLIC_URL=origUrl;});
    for(const language of ['ru','en'] as const){
      const f=await fixture();await accounts.updateMe(f.userId,{language});
      const click=(token:string)=>service.evaluate({event_type:'callback_query.received',chat_id:f.chatId,telegram_chat_id:f.telegram,
        inbound_message_id:f.panel,callback_data:token,raw_update:{callback_query:{message:{message_id:f.panel,chat:{id:f.telegram},reply_markup:f.markup}}}});
      const select=async(token:string,key:string)=>{const stage=await click(token);
        const product=stage.commerce_ui!.products.find(p=>p.feature_key===key);
        assert.ok(product,language+' '+key+' product: '+stage.reason);
        return click(product.callback_data);};
      const check=async(key:string,response:Awaited<ReturnType<typeof click>>)=>{
        assert.equal(response.commerce_ui?.step,'payment',language+' '+key+' '+response.reason);
        const options=response.commerce_ui!.payment_options!;
        assert.deepEqual(options.map(o=>o.source).sort(),language==='ru'?['sbp','stars']:['stars'],language+' '+key);
        for(const opt of options){
          const [stored]=await db`SELECT chat_id,action_kind,payload_json,amount,currency FROM public.interaction_tokens WHERE token=${opt.token}`;
          assert.equal(Number(stored!.chat_id),f.chatId);assert.equal(stored!.amount,opt.amount);assert.equal(stored!.currency,opt.currency);
          if(opt.source==='stars'){
            assert.match(opt.checkout_url,/^https:\/\/example\.invalid\/pay\//);
            const valid=await service.evaluate({event_type:'payment.pre_checkout.received',chat_id:f.chatId,invoice_payload:opt.token,
              pre_checkout_query_id:'check-'+opt.token,payment_currency:'XTR',payment_total_amount:opt.amount});
            assert.equal(valid.precheckout_ok,true,key+' '+valid.reason);
          }else{
            assert.ok(opt.checkout_url.endsWith('/v1/pay/sbp/'+encodeURIComponent(opt.token)));
            assert.equal(await service.resolveSbpCheckout(opt.token),'https://provider.invalid/pay/'+opt.token);
          }
          if(key==='scene_unlock'||key.includes('video_pass'))assert.equal(stored!.payload_json.duration_days,7);
        }
      };
      const subscription=async()=>{
        const menu=await service.evaluate({interaction_mode:'subscription_offer',chat_id:f.chatId,telegram_chat_id:f.telegram,scene_session_id:f.scene,
          subscription_offer_reason:'subscription_command',idempotency_key:'matrix-'+randomUUID()});
        await service.evaluate({interaction_mode:'finalize_subscription_offer',chat_id:f.chatId,offer_message_id:f.panel,
          subscription_invoice_tokens:menu.subscription_invoice_tokens});
        return menu;
      };
      const menu=await subscription();
      const before=await db`SELECT count(*)::int AS n FROM public.interaction_tokens WHERE chat_id=${f.chatId} AND kind='invoice_payload'`;
      const sceneStep=await click(f.initial.commerce_ui!.actions.scene!);
      const back=await click(sceneStep.commerce_ui!.actions.back!);
      assert.ok(back.commerce_ui?.actions.scene);assert.ok(back.commerce_ui?.actions.video);
      const wrong=await service.evaluate({event_type:'callback_query.received',chat_id:f.chatId,telegram_chat_id:f.telegram+1,
        callback_data:sceneStep.commerce_ui!.products[0]!.callback_data,inbound_message_id:f.panel+1});
      assert.equal(wrong.operation,'noop');
      const after=await db`SELECT count(*)::int AS n FROM public.interaction_tokens WHERE chat_id=${f.chatId} AND kind='invoice_payload'`;
      assert.equal(after[0]!.n,before[0]!.n,'stage 1, back and foreign click never create a payment attempt');
      for(const key of ['base','full'])await check(key,await click(menu.commerce_ui!.products.find(p=>p.feature_key===key)!.callback_data));
      await check('scene_unlock',await select(f.initial.commerce_ui!.actions.scene!,'scene_unlock'));
      await check('video_pass',await select(f.initial.commerce_ui!.actions.scene!,'video_pass'));
      await check('video_unlock',await select(f.initial.commerce_ui!.actions.video!,'video_unlock'));
      const photoToken='photo-matrix-'+randomUUID(),entry='photo-pay-'+randomUUID();
      const common={kind:'button_callback',chat_id:f.chatId,turn_no:0,scene_session_id:f.scene,status:'active',expires_at:null};
      await repo.upsertCallbackTokens([
        {...common,token:photoToken,action_kind:'free_photo_unlock',payload_json:{photo_sku:'tg_photo',current_uuid:f.photo,target_message_id:f.panel,media_signature:f.signature,base_price_xtr:100}},
        {...common,token:entry,action_kind:'commerce_photo_pay',payload_json:{surface:'daily_photos',user_id:f.userId,telegram_chat_id:f.telegram,target_message_id:f.panel,media_signature:f.signature,source_photo:f.photo,photo_token:photoToken}},
      ]);
      await check('photo_unlock',await click(entry));
      const paidScene=await select(f.initial.commerce_ui!.actions.scene!,'scene_unlock');
      const source=paidScene.commerce_ui!.payment_options!.find(o=>o.source==='stars')!;
      await pay(f.chatId,source.token);
      const upgrade=await select(f.initial.commerce_ui!.actions.scene!,'video_pass');
      assert.equal(upgrade.commerce_ui!.products[0]!.purchase_variant,'scene_unlock_upgrade');
      await check('video_pass upgrade',upgrade);
      const expired=upgrade.commerce_ui!.payment_options!.find(o=>o.source==='stars')!;
      await db`UPDATE public.chat_scene_sessions SET scene_access_unlocked_at=now()-interval '8 days' WHERE chat_id=${f.chatId} AND scene_session_id=${f.scene}`;
      const stale=await service.evaluate({event_type:'payment.pre_checkout.received',chat_id:f.chatId,invoice_payload:expired.token,
        pre_checkout_query_id:'expired-'+expired.token,payment_currency:'XTR',payment_total_amount:expired.amount});
      assert.equal(stale.precheckout_ok,false);assert.equal(stale.reason,'video_invoice_stale');
      await db`UPDATE public.users SET subscription_sku='tg_base',subscription_until=now()+interval '1 day',subscription_tier='base',subscription_tier_sku='tg_base' WHERE user_id=${f.userId}`;
      const renewed=await subscription();
      const full=await click(renewed.commerce_ui!.products.find(p=>p.feature_key==='full')!.callback_data);
      const [fullRow]=await db`SELECT payload_json FROM public.interaction_tokens WHERE token=${full.commerce_ui!.payment_options![0]!.token}`;
      assert.equal(fullRow!.payload_json.subscription_change,'upgrade');await check('base to full',full);
    }
  });

});
