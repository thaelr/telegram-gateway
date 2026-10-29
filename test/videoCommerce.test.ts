import test from 'node:test';
import assert from 'node:assert/strict';
import { installTestEnv } from './testEnv.js';
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
type Repo=ConstructorParameters<typeof MediaCommerceDecisionService>[0];
type VideoRepo=NonNullable<ConstructorParameters<typeof MediaCommerceDecisionService>[3]>;
const videoId='00000000-0000-4000-8000-000000000001';
const deliveryId='00000000-0000-4000-8000-000000000002';
const context:VideoContext={video:{video_id:videoId,bucket_name:'videos',storage_path:'one.mp4'},full_active:false,video_pass_active:false,
  subscription_sku:null,subscription_until:null,panel_delivered:false,scene_active:true};
const delivery:VideoDelivery={delivery_id:deliveryId,status:'pending',eligible_at:'2026-10-28T12:00:05Z',video_id:videoId,
  photo_message_id:77,telegram_chat_id:900,source:'telegram',bucket_name:'videos',storage_path:'one.mp4'};

function setup(overrides:Partial<VideoContext>={}) {
  const tokens=new Map<string,InteractionTokenRow>();
  const requests:unknown[]=[];
  let claimed=false;
  const invoices:unknown[]=[];
  const repo={
    async upsertCallbackTokens(rows:InteractionTokenRow[]){rows.forEach(row=>tokens.set(row.token,row));return rows.length;},
    async loadCallbackToken(token:string){const row=tokens.get(token);return row ? {...row,found:true,requested_token:token} : null;},
    async upsertInvoiceTokens(rows:Record<string,unknown>[]){invoices.push(...rows);return rows.map(row=>({...row,stored:true,status:'invoice_sent',invoice_link:`https://pay.test/${row.token}`,checkout_url:`https://pay.test/${row.token}`}));},
    async loadAbTestAssignment(){return null;},
    async loadSceneAccessStatus(){return {subscription_active:!!overrides.subscription_sku,scene_is_active:true,active_scene_session_id:'scene',scene_access_active:false};},
  } as unknown as Repo;
  const videos={
    async context(){return {...context,...overrides};},
    async storePanel(...args:unknown[]){requests.push(args);},
    async prepareDelivery(request:unknown){requests.push(request);return delivery;},
    async claimDelivery(){if(claimed)return null;claimed=true;return delivery;},
    async completeDelivery(){return {...delivery,status:'delivered',current_reply_markup:{inline_keyboard:[[{text:'Next',callback_data:'photo_next'}]]}};},
    async failDelivery(...args:unknown[]){requests.push(args);return {...delivery,status:args[3]?'failed':'uncertain'};},
  } as unknown as VideoRepo;
  const service=new MediaCommerceDecisionService(repo,{async createStarsInvoice(){throw Error('Unexpected Stars call');}},null,videos,
    async()=> 'https://private.test/signed');
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
test('subscription invoice snapshot freezes tier, upgrade source and discounts',()=>{
  const row=buildSubscriptionPaymentInputs({chat_id:1,idempotency_key:'offer',subscription_offer_reason:'subscription_command',turn_limit:20,
    turns_today:2,turn_limit_reset_text:'midnight',sort_order:1,plan:{...plan,sku:'full',days:30,tier:'full',subscription_change:'upgrade',upgrade_base_sku:'base_long',upgrade_discount_percent:15}})[0]!;
  assert.equal(row.action_kind,'subscription_payment');assert.equal(row.payload_json.subscription_tier,'full');
  assert.equal(row.payload_json.subscription_change,'upgrade');assert.equal(row.payload_json.upgrade_base_sku,'base_long');assert.equal(row.payload_json.subscription_days,30);
});
test('video context creates only callback metadata, with independent open-chat offer',async()=>{
  const {service,invoices}=setup();
  const result=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  assert.equal(result.video?.available,true);assert.ok(result.video?.animate_callback_data);assert.ok(result.video?.chat_offer_callback_data);assert.equal(invoices.length,0);
});
test('no matching video hides animate, Full and pass suppress the extra commercial offer',async()=>{
  for(const override of [{video:null},{panel_delivered:true},{full_active:true},{video_pass_active:true}]){
    const {service}=setup(override);const result=await service.evaluate({interaction_mode:'video_context',chat_id:1,scene_session_id:'scene',panel_message_id:77});
    if('video'in override || 'panel_delivered'in override) assert.equal(result.video?.animate_callback_data,undefined);
    if('full_active'in override || 'video_pass_active'in override) assert.equal(result.video?.chat_offer_callback_data,undefined);
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
  try {const rows=buildSubscriptionPaymentInputs({chat_id:1,idempotency_key:'rub-only',subscription_offer_reason:'subscription_command',turn_limit:20,
    turns_today:2,turn_limit_reset_text:'midnight',sort_order:1,plan:{...plan,amount_xtr:0,amount_rub:99,sku:'full',days:30,tier:'full',subscription_change:'upgrade',upgrade_base_sku:'base'}});
    assert.equal(rows.length,1);assert.equal(rows[0]!.payment_source,'sbp');assert.equal(rows[0]!.amount,99);
  } finally {config.SBP_ENABLED=enabled;}
});
test('standalone VideoPass reveal retains the animate callback',async()=>{
  const {service}=setup();const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  const markup={inline_keyboard:[[{text:'Animate',callback_data:prepared.video!.animate_callback_data}],[{text:'Pass',callback_data:prepared.video!.chat_offer_callback_data}]]};
  const result=await service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:prepared.video!.chat_offer_callback_data!,raw_update:{callback_query:{message:{reply_markup:markup}}}});
  assert.equal(result.video?.pass_payment_options?.length,1);assert.equal(result.video?.unlock_payment_options?.length,0);
  assert.ok(result.video_keep_tokens?.includes(prepared.video!.animate_callback_data!));assert.ok(!result.video_control_tokens?.includes(prepared.video!.animate_callback_data!));
});
