import test from 'node:test';
import assert from 'node:assert/strict';
import { installTestEnv, testTelegramUxCopy } from './testEnv.js';
import type { VideoContext, VideoDelivery } from '../src/videoCommerce.js';
import type { InteractionTokenRow } from '../src/mediaCommerceTypes.js';
installTestEnv();
process.env.MEDIA_VIDEO_ENABLED='true';
const plan = {sku:'base',amount_xtr:100,amount_rub:230,title:'Base',description:'Диалоги и фотографии',label:'Plan',button_text:'Buy'};
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...plan,days:7},{...plan,sku:'base_long',days:60},{...plan,sku:'full',tier:'full',days:30,amount_xtr:391,amount_rub:1279}]);
process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{...plan,sku:'photo'}]);
process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...plan,sku:'unlock',feature_key:'scene_unlock'},{...plan,sku:'video',feature_key:'video_unlock'},{...plan,sku:'pass',feature_key:'video_pass'}]);
process.env.SBP_ENABLED='false';
const {config}=await import('../src/config.js');
const {calculateFullUpgrade,roundUpgradePrice,resolveSubscriptionPlans}=await import('../src/mediaCommerce/plans.js');
const {MediaCommerceDecisionService}=await import('../src/mediaCommerceDecisionService.js');
const {buildSubscriptionPaymentInputs}=await import('../src/mediaCommerce/subscriptionFlow.js');
const {runWithMediaLocalization}=await import('../src/mediaLocalization.js');
type Repo=ConstructorParameters<typeof MediaCommerceDecisionService>[0];
type VideoRepo=NonNullable<ConstructorParameters<typeof MediaCommerceDecisionService>[3]>;
const videoId='00000000-0000-4000-8000-000000000001';
const deliveryId='00000000-0000-4000-8000-000000000002';
const photoId='11111111-1111-4111-8111-111111111111';
const context:VideoContext={video:{video_id:videoId,bucket_name:'videos',storage_path:'one.mp4',requested_photo_uuid:photoId,
  source_photo_uuid:photoId,source_photo_bucket_name:'photos',source_photo_storage_path:'one.jpg'},full_active:false,video_pass_active:false,
  subscription_sku:null,subscription_until:null,panel_delivered:false,scene_active:true};
const delivery:VideoDelivery={delivery_id:deliveryId,status:'pending',eligible_at:'2026-10-28T12:00:05Z',video_id:videoId,
  photo_message_id:77,telegram_chat_id:900,source:'telegram',bucket_name:'videos',storage_path:'one.mp4',chat_id:1,
  requested_photo_uuid:photoId,source_photo_uuid:photoId,source_photo_bucket_name:'photos',source_photo_storage_path:'one.jpg',same_photo:true};
const localization={
  async getTelegramCopy(){return testTelegramUxCopy;},
  async getPaymentMethods():Promise<Array<'stars'|'sbp'>>{return config.SBP_ENABLED ? ['sbp','stars'] : ['stars'];},
  async getNamespace(){return {};},
};
const withLocalization=<T>(execute:()=>T)=>runWithMediaLocalization({
  language:'ru',uxCopy:testTelegramUxCopy,
  paymentMethods:(config.SBP_ENABLED ? ['sbp','stars'] : ['stars']) as Array<'stars'|'sbp'>,
  commerceCopy:{},
},execute);

function setup(overrides:Partial<VideoContext>={}, paidSceneUnlockToken: string | null = null) {
  const tokens=new Map<string,InteractionTokenRow>();
  const requests:unknown[]=[];
  let claimed=false;
  let currentDelivery=delivery;
  const invoices:unknown[]=[];
  const repo={
    async upsertCallbackTokens(rows:InteractionTokenRow[]){rows.forEach(row=>tokens.set(row.token,row));return rows.length;},
    async loadCallbackToken(token:string){const row=tokens.get(token);return row ? {...row,found:true,requested_token:token} : null;},
    async loadMediaContext(){return {unlocked_items_json:[{uuid:photoId,photo_url:'https://private.test/photo'}]};},
    async loadPhotoByUuid(){return {photo_url:'https://private.test/photo'};},
    async upsertInvoiceTokens(rows:Record<string,unknown>[]){invoices.push(...rows);return rows.map(row=>({...row,stored:true,status:'invoice_sent',invoice_link:`https://pay.test/${row.token}`,checkout_url:`https://pay.test/${row.token}`}));},
    async loadAbTestAssignment(){return null;},
    async loadSceneAccessStatus(){return {subscription_active:!!overrides.subscription_sku,scene_is_active:true,active_scene_session_id:'scene',scene_access_active:false};},
  } as unknown as Repo;
  const videos={
    async context(){return {...context,...overrides};},
    async passOfferContext(){return {scene_session_id:'scene',user_id:'owner',available:!!({...context,...overrides}).video && !overrides.panel_delivered,
      paid_scene_unlock_token:paidSceneUnlockToken,subscription_active:!!overrides.subscription_sku,full_active:!!overrides.full_active,video_pass_active:!!overrides.video_pass_active,scene_access_active:!!paidSceneUnlockToken};},
    async storePanel(...args:unknown[]){requests.push(args);},
    async prepareDelivery(request:unknown){requests.push(request);return delivery;},
    async getDelivery(){return currentDelivery;},
    async claimDelivery(){if(claimed)return null;claimed=true;return currentDelivery;},
    async completeDelivery(){currentDelivery={...delivery,status:'delivered',telegram_message_id:77,current_reply_markup:{inline_keyboard:[[{text:'Next',callback_data:'photo_next'}]]}};return currentDelivery;},
    async failDelivery(...args:unknown[]){requests.push(args);return {...delivery,status:args[3]?'failed':'uncertain'};},
  } as unknown as VideoRepo;
  const service=new MediaCommerceDecisionService(repo,{async createStarsInvoice(){throw Error('Unexpected Stars call');}},null,videos,
    async()=> 'https://private.test/signed',localization);
  return {service,tokens,requests,invoices};
}

test('upgrade uses nominal Base separately per currency, no remaining-term factor',()=>{
  assert.deepEqual(calculateFullUpgrade({amount_xtr:600,amount_rub:1600},{amount_xtr:200,amount_rub:700},10),{amount_xtr:369,amount_rub:819});
  assert.deepEqual(calculateFullUpgrade({amount_xtr:100,amount_rub:10},{amount_xtr:100,amount_rub:20},0),{amount_xtr:0,amount_rub:0});
});
test('ending 9 rounding is predictable and never undercharges positive raw value',()=>{
  for(const value of [0.01,1,8.9,9,9.0001,10,18.99,19,199.7,10000]){
    const result=roundUpgradePrice(value);assert.equal(result%10,9);assert.ok(result>=value);assert.ok(result-value<10 || result===9);
  }
  assert.equal(roundUpgradePrice(0),0);assert.equal(roundUpgradePrice(-9),0);assert.throws(()=>roundUpgradePrice(NaN));
});
test('Full discount retains precision until the final upgrade rounding',()=>{
  const old=config.MEDIA_FULL_DISCOUNT_PERCENT;config.MEDIA_FULL_DISCOUNT_PERCENT=17;
  try {const full=resolveSubscriptionPlans().find(plan=>plan.tier==='full')!;
    assert.equal(full.upgrade_full_amount_xtr,391*.83);
    assert.deepEqual(calculateFullUpgrade(full,{amount_xtr:100,amount_rub:230},13),{amount_xtr:199,amount_rub:729});
    assert.equal(resolveSubscriptionPlans().filter(plan=>plan.tier!=='full').length,2);
  }finally{config.MEDIA_FULL_DISCOUNT_PERCENT=old;}
});
test('subscription invoice snapshot freezes tier, upgrade source and discounts',()=>withLocalization(()=>{
  const row=buildSubscriptionPaymentInputs({chat_id:1,idempotency_key:'offer',subscription_offer_reason:'subscription_command',turn_limit:20,
    turns_today:2,turn_limit_reset_text:'midnight',sort_order:1,plan:{...plan,sku:'full',days:30,tier:'full',subscription_change:'upgrade',upgrade_base_sku:'base_long',upgrade_discount_percent:15}})[0]!;
  assert.equal(row.action_kind,'subscription_payment');assert.equal(row.payload_json.subscription_tier,'full');
  assert.equal(row.payload_json.subscription_change,'upgrade');assert.equal(row.payload_json.upgrade_base_sku,'base_long');assert.equal(row.payload_json.subscription_days,30);
}));
test('video context creates only callback metadata, with independent open-chat offer',async()=>{
  const {service,invoices}=setup();
  const result=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  assert.equal(result.video?.available,true);assert.ok(result.video?.animate_callback_data);assert.ok(result.video?.chat_offer_callback_data);assert.equal(invoices.length,0);
});
test('no matching video hides animate, Full and pass suppress the extra commercial offer',async()=>{
  for(const override of [{video:null},{panel_delivered:true},{delivery},{full_active:true},{video_pass_active:true}]){
    const {service}=setup(override);const result=await service.evaluate({interaction_mode:'video_context',chat_id:1,scene_session_id:'scene',panel_message_id:77});
    if('video'in override || 'panel_delivered'in override) assert.equal(result.video?.animate_callback_data,undefined);
    assert.equal(result.video?.chat_offer_callback_data,undefined);
  }
});
test('entitled click freezes video and original panel into a delivery without invoices',async()=>{
  const {service,requests,invoices}=setup({full_active:true});
  const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  const result=await service.evaluate({event_type:'callback_query.received',interaction_mode:'callback',chat_id:1,telegram_chat_id:900,callback_data:prepared.video!.animate_callback_data!});
  assert.equal(result.operation,'video_delivery_required');assert.equal(result.target_message_id,77);assert.equal(invoices.length,0);
  assert.equal((requests[0] as {video_id:string}).video_id,videoId);
});
test('claims are required before exposing signed URL; duplicate claims do not send',async()=>{
  const {service}=setup();
  const first=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:deliveryId});
  assert.equal(first.operation,'video_delivery_claimed');assert.ok(first.claim_token);assert.equal(first.target_message_id,77);assert.ok(first.video_url);
  const second=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:deliveryId});
  assert.equal(second.operation,'noop');assert.equal(second.video_url,undefined);
});
test('success returns latest persisted panel; ambiguous failure is never made retryable implicitly',async()=>{
  const {service,requests}=setup();
  const success=await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:deliveryId,claim_token:deliveryId,delivery_success:true,sent_message_id:100});
  assert.equal(success.delivered,true);assert.deepEqual(success.reply_markup,{inline_keyboard:[[{text:'Next',callback_data:'photo_next'}]]});
  const failure=await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:deliveryId,claim_token:deliveryId,delivery_success:false});
  assert.equal(failure.reason,'video_delivery_uncertain');assert.equal((requests[0] as unknown[])[3],false);
});
test('confirmed navigation survives financial TTL; claim, foreign owner and wrong panel cannot view media',async()=>{
  const {service,tokens}=setup();
  const claimed=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:deliveryId,chat_id:1});
  const token=claimed.video_panel_video_callback_data!;
  const click=(telegram_chat_id=900,inbound_message_id=77)=>service.evaluate({interaction_mode:'callback',
    event_type:'callback_query.received',chat_id:1,telegram_chat_id,inbound_message_id,callback_data:token});
  assert.ok(tokens.get(token)?.expires_at);
  assert.equal((await click()).operation,'noop');
  await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:deliveryId,claim_token:deliveryId,delivery_success:true,sent_message_id:77,chat_id:1});
  assert.equal(tokens.get(token)?.expires_at,null);
  assert.equal((await click(901)).operation,'noop');
  assert.equal((await click(900,78)).operation,'noop');
  const video=await click();
  assert.equal(video.operation,'video_panel_media_ready');assert.equal(video.panel_media_kind,'video');
  assert.deepEqual(video.panel_navigation_row?.map(button=>button.callback_data),
    [claimed.video_panel_requested_callback_data,token,claimed.video_panel_requested_callback_data]);
});
test('failed paid one-shot delivery retries without another checkout',async()=>{
  const {service,invoices}=setup({delivery:{...delivery,status:'failed'}});
  const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  const result=await service.evaluate({event_type:'callback_query.received',interaction_mode:'callback',chat_id:1,callback_data:prepared.video!.animate_callback_data!});
  assert.equal(result.operation,'video_delivery_required');assert.equal(result.delivery_id,deliveryId);assert.equal(invoices.length,0);
});
test('active Full subscription retains its terms and end date without another upgrade',async()=>{
  const {service,invoices}=setup({full_active:true,subscription_sku:'full',subscription_until:'2099-01-01T00:00:00Z'});
  const result=await service.evaluate({interaction_mode:'subscription_offer',chat_id:1,idempotency_key:'offer'});
  assert.equal(result.operation,'subscription_offer_ready');assert.equal(result.subscription_tier,'full');assert.match(result.text!,/2099-01-01/);assert.match(result.text!,/диалоги/i);assert.equal(invoices.length,0);
});
test('animate checkout snapshots the selected video; reveal replaces only known video controls',async()=>{
  const {service,invoices}=setup();
  const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  const markup={inline_keyboard:[[{text:'Next',callback_data:'photo_next'}],[{text:'Video access',callback_data:prepared.video!.chat_offer_callback_data}],[{text:'Animate',callback_data:prepared.video!.animate_callback_data}]]};
  const result=await service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:prepared.video!.animate_callback_data!,raw_update:{callback_query:{message:{reply_markup:markup}}}});
  assert.equal(result.operation,'video_ui_ready');assert.equal(result.video?.unlock_payment_options?.length,1);
  assert.equal(result.video?.pass_price_rub,230);assert.equal(result.video?.pass_payment_options?.length,0);
  assert.ok(result.video_control_tokens?.includes(prepared.video!.chat_offer_callback_data!));assert.ok(!result.video_control_tokens?.includes('photo_next'));
  const snapshot=(invoices[0] as {payload_json:Record<string,unknown>}).payload_json;
  assert.equal(snapshot.video_id,videoId);assert.equal(snapshot.photo_message_id,77);assert.equal(snapshot.telegram_chat_id,900);
  const pass=await service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:result.video!.pass_reveal_callback_data!,raw_update:{callback_query:{message:{reply_markup:markup}}}});
  assert.equal(pass.video?.pass_payment_options?.length,1);assert.equal(pass.video?.unlock_payment_options?.length,1);
});
test('active Base uses nominal configured SKU and keeps existing subscription conditions',async()=>{
  const {service,invoices}=setup({subscription_sku:'base_long',subscription_until:'2099-01-01T00:00:00Z'});
  const result=await service.evaluate({interaction_mode:'subscription_offer',chat_id:1,idempotency_key:'offer'});
  assert.match(result.text!,/Диалоги и фотографии/);assert.match(result.text!,/2099-01-01/);
  assert.equal(invoices.length,1);
  const invoice=invoices[0] as {amount:number;payload_json:Record<string,unknown>};
  assert.equal(invoice.amount,299);assert.equal(invoice.payload_json.upgrade_base_sku,'base_long');assert.equal(invoice.payload_json.subscription_change,'upgrade');assert.equal(invoice.payload_json.subscription_days,30);
});
test('stale photo callback cannot mint a payment for the previous photo',async()=>{
  const {service,invoices}=setup({panel_media_signature:'new-signature'});
  const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'old-signature',panel_message_id:77});
  const result=await service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:prepared.video!.animate_callback_data!});
  assert.equal(result.reason,'video_panel_changed');assert.equal(invoices.length,0);
});
test('upgrade payment sources are independent when only RUB remains positive',()=>{
  const enabled=config.SBP_ENABLED;config.SBP_ENABLED=true;
  try {return withLocalization(()=>{const rows=buildSubscriptionPaymentInputs({chat_id:1,idempotency_key:'rub-only',subscription_offer_reason:'subscription_command',turn_limit:20,
    turns_today:2,turn_limit_reset_text:'midnight',sort_order:1,plan:{...plan,amount_xtr:0,amount_rub:99,sku:'full',days:30,tier:'full',subscription_change:'upgrade',upgrade_base_sku:'base'}});
    assert.equal(rows.length,1);assert.equal(rows[0]!.payment_source,'sbp');assert.equal(rows[0]!.amount,99);
  });} finally {config.SBP_ENABLED=enabled;}
});
test('standalone VideoPass reveal retains the animate callback',async()=>{
  const {service}=setup();const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  const markup={inline_keyboard:[[{text:'Animate',callback_data:prepared.video!.animate_callback_data}],[{text:'Pass',callback_data:prepared.video!.chat_offer_callback_data}]]};
  const result=await service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:prepared.video!.chat_offer_callback_data!,raw_update:{callback_query:{message:{reply_markup:markup}}}});
  assert.equal(result.video?.pass_payment_options?.length,1);assert.equal(result.video?.unlock_payment_options?.length,0);
  assert.ok(result.video_keep_tokens?.includes(prepared.video!.animate_callback_data!));assert.ok(!result.video_control_tokens?.includes(prepared.video!.animate_callback_data!));
});

test('scene offer uses separate upgrade prices, original amount and server-selected variant',async(t)=>{
  const pass=config.MEDIA_ACTION_PLANS_JSON.find(item=>item.feature_key==='video_pass')!;
  const old=pass.scene_unlock_upgrade;
  const oldPromos=config.MEDIA_PROMOTIONS_JSON;
  t.after(()=>{pass.scene_unlock_upgrade=old;config.MEDIA_PROMOTIONS_JSON=oldPromos;});
  config.MEDIA_PROMOTIONS_JSON=[{promo_key:'test-pass',starts_at:'2000-01-01T00:00:00Z',ends_at:'2099-01-01T00:00:00Z',
    items:[{sku:pass.sku,promo_amount_xtr:10,promo_amount_rub:20}]}];
  pass.scene_unlock_upgrade={amount_xtr:101,amount_rub:227,discount_percent:50};
  const upgraded=setup({},'paid-scene');
  const open={interaction_mode:'video_context' as const,chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77,current_uuid:photoId};
  const visible=await upgraded.service.evaluate(open);
  assert.match(visible.video!.pass_button_text!,/101.*51.*50%/);
  const response=await upgraded.service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:visible.video!.chat_offer_callback_data!});
  const option=response.video?.pass_payment_options?.[0];
  assert.deepEqual([option?.amount,option?.original_amount,option?.discount_percent],[51,101,50]);
  const invoice=(upgraded.invoices as Array<{payload_json:Record<string,unknown>}>)[0]!.payload_json;
  assert.deepEqual([invoice.purchase_variant,invoice.original_amount,invoice.final_amount,invoice.currency,invoice.discount_percent,invoice.paid_scene_unlock_token,invoice.user_id,invoice.video_id,invoice.pass_only,invoice.promo_key],
    ['scene_unlock_upgrade',101,51,'XTR',50,'paid-scene','owner',null,true,null]);
  const concrete=await upgraded.service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:visible.video!.animate_callback_data!});
  assert.ok(concrete.video?.pass_reveal_callback_data);
  const both=upgraded.invoices as Array<{token:string,payload_json:Record<string,unknown>}>;
  assert.equal(both.filter(row=>row.payload_json.feature_key==='video_pass'&&row.payload_json.video_id===videoId).length,1);
  assert.equal(new Set(both.map(row=>row.token)).size,both.length);
  const products=await upgraded.service.webProductPlans(1);
  assert.deepEqual(products.filter(p=>p.feature_key==='video_pass').map(p=>[p.amount_rub,p.original_amount_rub,p.purchase_variant]),[[114,227,'scene_unlock_upgrade']]);
  assert.equal(products.some(p=>p.feature_key==='scene_unlock'),false);
  assert.equal((await upgraded.service.webProductPlans(null)).some(p=>p.feature_key==='video_pass'),false);
  assert.deepEqual((await setup().service.webProductPlans(1)).filter(p=>p.feature_key==='video_pass').map(p=>[p.amount_xtr,p.purchase_variant]),[[10,'standard']]);
  delete pass.scene_unlock_upgrade;
  assert.deepEqual((await upgraded.service.webProductPlans(1)).filter(p=>p.feature_key==='video_pass').map(p=>[p.amount_xtr,p.purchase_variant]),[[10,'standard']]);
});

test('subscription command and daily paywall independently keep Scene Unlock and gate VideoPass by available media',async()=>{
  for(const reason of ['subscription_command','daily_turn_limit'] as const){
    for(const available of [true,false]){
      const {service}=setup(available ? {} : {video:null});
      const menu=await service.evaluate({interaction_mode:'subscription_offer',subscription_offer_reason:reason,
        idempotency_key:'menu-'+reason,chat_id:1,scene_session_id:'scene',telegram_chat_id:900});
      assert.equal(menu.operation,'subscription_offer_ready');
      assert.ok(menu.token_rows?.some(item=>item.action_kind==='free_scene_unlock'));
      assert.equal(!!menu.video?.chat_offer_callback_data,available);
      assert.ok(menu.subscription_offer_items?.some(item=>item.payment_kind==='subscription'));
      if(!available)continue;
      const reveal=await service.evaluate({interaction_mode:'callback',event_type:'callback_query.received',chat_id:1,
        callback_data:menu.video!.chat_offer_callback_data!,inbound_message_id:91});
      assert.equal(reveal.video?.pass_menu,true);assert.equal(reveal.target_message_id,91);
      assert.equal(reveal.video?.pass_payment_options?.length,1);assert.equal(reveal.video?.unlock_payment_options?.length,0);
    }
  }
});

test('Web chat with Base can still buy a VideoPass; active subscriptions remove redundant Scene Unlock',async()=>{
  const base=await setup({subscription_sku:'base',subscription_until:'2099-01-01T00:00:00Z'}).service.webProductPlans(1);
  assert.equal(base.some(p=>p.feature_key==='scene_unlock'),false);assert.ok(base.some(p=>p.feature_key==='video_pass'));
  const full=await setup({subscription_sku:'full',subscription_until:'2099-01-01T00:00:00Z',full_active:true}).service.webProductPlans(1);
  assert.equal(full.some(p=>p.feature_key==='video_pass'||p.feature_key==='scene_unlock'),false);
});
