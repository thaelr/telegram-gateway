import test from 'node:test';
import assert from 'node:assert/strict';
import { installTestEnv, testTelegramUxCopy } from './testEnv.js';
import type { VideoContext, VideoDelivery } from '../src/modules/media/videoRepository.js';
import type { InteractionTokenRow } from '../src/mediaCommerceTypes.js';
installTestEnv();
process.env.MEDIA_VIDEO_ENABLED='true';
const plan = {sku:'base',amount_xtr:100,amount_rub:230,title:'Base',description:'Диалоги и фотографии',label:'Plan',button_text:'Buy'};
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...plan,days:7},{...plan,sku:'base_long',days:60},{...plan,sku:'full',tier:'full',days:30,amount_xtr:391,amount_rub:1279}]);
process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{...plan,sku:'photo'}]);
process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...plan,sku:'unlock',feature_key:'scene_unlock'},{...plan,sku:'video',feature_key:'video_unlock'},{...plan,sku:'pass',feature_key:'video_pass'}]);
process.env.SBP_ENABLED='false';
const {config}=await import('../src/config.js');
const {calculateFullUpgrade,roundUpgradePrice,resolveSubscriptionPlans}=await import('../src/modules/products/plans.js');
const {MediaCommerceDecisionService}=await import('../src/application/mediaCommerceDecision.js');
const {buildSubscriptionPaymentInputs,getPaymentPrices}=await import('../src/modules/commerce/subscriptionFlow.js');
const {runWithMediaLocalization}=await import('../src/mediaLocalization.js');
type Repo=ConstructorParameters<typeof MediaCommerceDecisionService>[0];
type VideoRepo=NonNullable<ConstructorParameters<typeof MediaCommerceDecisionService>[3]>;
const videoId='00000000-0000-4000-8000-000000000001';
const deliveryId='00000000-0000-4000-8000-000000000002';
const photoId='11111111-1111-4111-8111-111111111111';
const context:VideoContext={video:{video_id:videoId,bucket_name:'videos',storage_path:'one.mp4',requested_photo_uuid:photoId,
  source_photo_uuid:photoId,media_signature:'signature',source_photo_bucket_name:'photos',source_photo_storage_path:'one.jpg'},full_active:false,video_pass_active:false,
  subscription_sku:null,subscription_until:null,panel_delivered:false,scene_active:true};
const delivery:VideoDelivery={delivery_id:deliveryId,status:'pending',eligible_at:'2026-10-28T12:00:05Z',video_id:videoId,
  photo_message_id:77,telegram_chat_id:900,source:'telegram',bucket_name:'videos',storage_path:'one.mp4',chat_id:1,
  requested_photo_uuid:photoId,source_photo_uuid:photoId,source_photo_bucket_name:'photos',source_photo_storage_path:'one.jpg',same_photo:true,
  payment_token:'pay_v_fixture_u:stars',current_reply_markup:{inline_keyboard:[
    [{text:'SBP',url:'https://gateway.example/v1/pay/sbp/pay_v_fixture_u%3Asbp'}]
  ]}};
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

async function click(service:InstanceType<typeof MediaCommerceDecisionService>,token:string,panel=77) {
  return service.evaluate({event_type:'callback_query.received',chat_id:1,telegram_chat_id:900,inbound_message_id:panel,callback_data:token});
}
function setup(overrides:Partial<VideoContext>={}, paidSceneUnlockToken: string | null = null,language:'ru'|'en'='ru') {
  let currentLanguage=language;
  const tokens=new Map<string,InteractionTokenRow>();
  const requests:unknown[]=[];
  let claimed=false;
  let currentDelivery=delivery;
  const invoices:unknown[]=[];
  const repo={
    async loadAccountLanguage(){return currentLanguage;},
    async upsertInvoiceToken(row:Record<string,unknown>){invoices.push(row);return {...row,stored:true,status:'invoice_sent',invoice_link:'https://pay.test/'+row.token};},
    async upsertCallbackTokens(rows:InteractionTokenRow[]){rows.forEach(row=>tokens.set(row.token,row));return rows.length;},
    async loadCallbackToken(token:string){const row=tokens.get(token);return row ? {...row,found:true,requested_token:token} : null;},
    async loadMediaContext(){return {unlocked_items_json:[{uuid:photoId,photo_url:'https://private.test/photo'}]};},
    async loadPhotoByUuid(){return {photo_url:'https://private.test/photo'};},
    async upsertInvoiceTokens(rows:Record<string,unknown>[]){invoices.push(...rows);return rows.map(row=>({...row,stored:true,status:'invoice_sent',invoice_link:`https://pay.test/${row.token}`,checkout_url:`https://pay.test/${row.token}`}));},
    async loadAbTestAssignment(){return null;},
    async storeAbTestAssignment(_chatId:number,_key:string,assignment:unknown){return assignment;},
    async loadActiveSubscriptionOfferId(){return null;},
    async loadStoredInvoiceTokens(){return [];},
    async loadFreeCredits(){return {free_scene_unlocks:0};},
    async loadSceneAccessStatus(){return {subscription_active:!!overrides.subscription_sku,scene_is_active:true,active_scene_session_id:'scene',scene_access_active:!!paidSceneUnlockToken};},
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
  return {service,tokens,requests,invoices,setLanguage(value:'ru'|'en'){currentLanguage=value;}};
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
  const {service,invoices,tokens}=setup();
  const result=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  assert.equal(result.video?.available,true);assert.ok(result.video?.animate_callback_data);assert.ok(result.video?.chat_offer_callback_data);assert.equal(invoices.length,0);
  assert.ok(result.commerce_ui?.actions.video);assert.ok(result.commerce_ui?.actions.scene);
  assert.deepEqual(result.commerce_ui?.products.map(product=>product.feature_key),
    ['scene_unlock','video_unlock','video_pass','base','base','full']);
  assert.notEqual(result.commerce_ui.actions.video,result.commerce_ui.actions.scene);
  assert.equal(tokens.get(result.commerce_ui.actions.video!)?.action_kind,'video_request');
  assert.equal(tokens.get(result.commerce_ui.actions.scene!)?.action_kind,'commerce_scene');
  assert.equal(tokens.get(result.commerce_ui.actions.video!)?.payload_json.action_button_text,null);
  assert.equal(tokens.get(result.commerce_ui.actions.scene!)?.payload_json.action_button_text,null);
});
test('capabilities v1 exposes independent products, refresh and selected purchase without changing legacy',async()=>{
  const {service,tokens,invoices}=setup();
  const request={interaction_mode:'video_context' as const,chat_id:1,telegram_chat_id:900,scene_session_id:'scene',
    media_signature:'signature',current_uuid:photoId,panel_message_id:77};
  const legacy=await service.evaluate(request);
  assert.equal(legacy.commerce_capabilities,undefined);
  const result=await service.evaluate({...request,commerce_capabilities_version:1 as const,ui_origin:'media_panel'});
  const capabilities=result.commerce_capabilities!;
  assert.deepEqual(capabilities.context,{origin:'media_panel',kind:'photo',scene_session_id:'scene',message_id:77,
    current_uuid:photoId,media_signature:'signature'});
  assert.equal(tokens.get(capabilities.controls.refresh!)?.action_kind,'commerce_ui_refresh');
  const actionProducts=capabilities.products.filter(product=>['scene_unlock','video_unlock','video_pass'].includes(product.feature_key));
  assert.deepEqual(actionProducts.map(product=>[product.feature_key,product.purchase_context]),[
    ['scene_unlock','access_only'],['video_unlock','access_and_video'],['video_pass','access_only'],['video_pass','access_and_video'],
  ]);
  for(const product of actionProducts)assert.equal(tokens.get(product.callback_data!)?.action_kind,'commerce_pay');
  assert.ok(capabilities.products.every(product=>product.callback_data||product.payment_options?.length));
  for(const product of capabilities.products.filter(product=>product.subscription_tier)){
    assert.equal(tokens.get(product.callback_data!)?.action_kind,'commerce_subscriptions');
  }
  assert.equal(invoices.length,0);
  const subscription=capabilities.products.find(product=>product.subscription_tier)!;
  const selectedSubscription=await click(service,subscription.callback_data!);
  assert.equal(selectedSubscription.commerce_capabilities?.selected_purchase?.sku,subscription.sku);
  assert.ok(selectedSubscription.commerce_capabilities?.selected_purchase?.payment_options.length);
  assert.ok(selectedSubscription.commerce_capabilities?.products.some(product=>product.feature_key==='video_unlock'));

  const invoicesBeforeRefresh=invoices.length;
  const refreshed=await click(service,capabilities.controls.refresh!);
  assert.equal(refreshed.operation,'video_ui_ready');assert.equal(refreshed.commerce_capabilities?.version,1);
  assert.equal(invoices.length,invoicesBeforeRefresh,'refresh must not create payment attempts');
  const accessOnly=capabilities.products.find(product=>product.feature_key==='video_pass'&&product.purchase_context==='access_only')!;
  const selected=await click(service,accessOnly.callback_data!);
  assert.deepEqual([selected.commerce_capabilities?.selected_purchase?.feature_key,
    selected.commerce_capabilities?.selected_purchase?.purchase_context],['video_pass','access_only']);
  assert.ok(selected.commerce_capabilities?.selected_purchase?.payment_options.length);
  assert.ok(selected.commerce_capabilities?.products.some(product=>product.feature_key==='video_unlock'));
  const stale=await click(service,capabilities.controls.refresh!,78);
  assert.equal(stale.operation,'noop');assert.equal(stale.callback_valid,false);

  const unavailable=await setup({video:null}).service.evaluate({...request,commerce_capabilities_version:1});
  assert.equal(unavailable.commerce_capabilities?.products.some(product=>
    product.feature_key==='video_unlock'||product.feature_key==='video_pass'),false);
  const entitled=await setup({full_active:true}).service.evaluate({...request,commerce_capabilities_version:1});
  assert.equal(entitled.commerce_capabilities?.products.some(product=>
    ['scene_unlock','video_unlock','video_pass'].includes(product.feature_key)),false);
});
test('no matching video hides animate, Full and pass suppress the extra commercial offer',async()=>{
  for(const override of [{video:null},{panel_delivered:true},{delivery},{full_active:true},{video_pass_active:true}]){
    const {service,tokens}=setup(override);const result=await service.evaluate({interaction_mode:'video_context',chat_id:1,scene_session_id:'scene',panel_message_id:77});
    if('video'in override || 'panel_delivered'in override) assert.equal(result.video?.animate_callback_data,undefined);
    if('full_active' in override)assert.equal(result.commerce_ui?.actions.scene,undefined);
    else {
      assert.ok(result.commerce_ui?.actions.scene,'scene commerce remains available when at least one independent product exists');
      assert.equal(tokens.get(result.commerce_ui.actions.scene!)?.action_kind,'commerce_scene');
    }
    if(override.video===null)assert.equal(result.commerce_ui?.actions.video,undefined);
    if(override.video===null||override.panel_delivered||override.delivery||override.full_active||override.video_pass_active){
      assert.equal(result.commerce_ui?.products.some(product=>product.feature_key==='video_unlock'||product.feature_key==='video_pass'),false);
    }
  }
});
test('entitled click freezes video and original panel into a delivery without invoices',async()=>{
  const {service,requests,invoices}=setup({full_active:true});
  const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  const result=await service.evaluate({event_type:'callback_query.received',interaction_mode:'callback',chat_id:1,telegram_chat_id:900,callback_data:prepared.video!.animate_callback_data!});
  assert.equal(result.operation,'video_delivery_required');assert.equal(result.target_message_id,77);assert.equal(invoices.length,0);
  assert.equal((requests[0] as {video_id:string}).video_id,videoId);
  assert.equal((requests[0] as {media_signature:string}).media_signature,'signature');
});
test('claims are required before exposing signed URL; duplicate claims do not send',async()=>{
  const {service}=setup();
  const first=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:deliveryId});
  assert.equal(first.operation,'video_delivery_claimed');assert.ok(first.claim_token);assert.equal(first.target_message_id,77);assert.ok(first.video_url);
  const second=await service.evaluate({interaction_mode:'claim_video_delivery',delivery_id:deliveryId});
  assert.equal(second.operation,'noop');assert.equal(second.video_url,undefined);
});
test('success returns latest persisted panel; ambiguous failure is never made retryable implicitly',async()=>{
  const enabled=config.SBP_ENABLED;config.SBP_ENABLED=true;
  try {
    const {service,requests}=setup();
    const success=await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:deliveryId,claim_token:deliveryId,delivery_success:true,sent_message_id:100});
    assert.equal(success.delivered,true);assert.deepEqual(success.reply_markup,{inline_keyboard:[[{text:'Next',callback_data:'photo_next'}]]});
    assert.ok(success.video_payment_urls?.includes('https://gateway.example/v1/pay/sbp/pay_v_fixture_u%3Asbp'));
    const failure=await service.evaluate({interaction_mode:'finalize_video_delivery',delivery_id:deliveryId,claim_token:deliveryId,delivery_success:false});
    assert.equal(failure.reason,'video_delivery_uncertain');assert.equal((requests.at(-1) as unknown[])[3],false);
  } finally {config.SBP_ENABLED=enabled;}
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
  assert.deepEqual(result.commerce_ui?.products.map(p=>p.feature_key),
    ['scene_unlock','video_unlock','video_pass','base','base','full']);
  assert.equal(invoices.length,1,'the existing direct one-time video checkout remains the only eager exception');
  const beforeSelected=invoices.length;
  const payment=await click(service,result.commerce_ui!.products.find(product=>product.feature_key==='video_unlock')!.callback_data!);
  assert.equal(payment.commerce_ui?.step,'payment');assert.equal(payment.commerce_ui?.payment_origin_step,'video');
  assert.equal(payment.commerce_ui?.payment_options?.length,1);
  const snapshot=(invoices[0] as {payload_json:Record<string,unknown>}).payload_json;
  assert.equal(snapshot.video_id,videoId);assert.equal(snapshot.photo_message_id,77);assert.equal(snapshot.telegram_chat_id,900);
  const back=await click(service,payment.commerce_ui!.actions.back!);
  assert.deepEqual(back.commerce_ui?.products.map(p=>p.feature_key),
    ['scene_unlock','video_unlock','video_pass','base','base','full']);assert.ok(invoices.length>=beforeSelected);
  const pass=await click(service,back.commerce_ui!.products.find(product=>product.feature_key==='video_pass')!.callback_data!);
  assert.equal(pass.commerce_ui?.payment_origin_step,'video');assert.equal(pass.commerce_ui?.payment_options?.[0]?.feature_key,'video_pass');
});
test('pose fallback freezes scene and selected video signatures separately',async()=>{
  const sourcePhoto='22222222-2222-4222-8222-222222222222';
  const fallback={...context.video!,media_signature:'scene_close_standing_dress_front',source_photo_uuid:sourcePhoto};
  const {service,invoices}=setup({video:fallback});
  const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',
    media_signature:'scene_close_sitting_dress_front',panel_message_id:77});
  assert.ok(prepared.video?.animate_callback_data);
  await service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:prepared.video!.animate_callback_data!});
  const snapshot=(invoices[0] as {payload_json:Record<string,unknown>}).payload_json;
  assert.equal(snapshot.media_signature,'scene_close_sitting_dress_front');
  assert.equal(snapshot.video_media_signature,'scene_close_standing_dress_front');
  assert.equal(snapshot.video_id,videoId);assert.equal(snapshot.source_photo_uuid,sourcePhoto);
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
  assert.equal(result.reason,'commerce_screen_stale');assert.equal(invoices.length,0);
});
test('upgrade payment sources are independent when only RUB remains positive',()=>{
  const enabled=config.SBP_ENABLED;config.SBP_ENABLED=true;
  try {return withLocalization(()=>{const rows=buildSubscriptionPaymentInputs({chat_id:1,idempotency_key:'rub-only',subscription_offer_reason:'subscription_command',turn_limit:20,
    turns_today:2,turn_limit_reset_text:'midnight',sort_order:1,plan:{...plan,amount_xtr:0,amount_rub:99,sku:'full',days:30,tier:'full',subscription_change:'upgrade',upgrade_base_sku:'base'}});
    assert.equal(rows.length,1);assert.equal(rows[0]!.payment_source,'sbp');assert.equal(rows[0]!.amount,99);
    assert.deepEqual(getPaymentPrices({amount_xtr:0,amount_rub:0}),[],'zero-price providers are not fabricated');
  });} finally {config.SBP_ENABLED=enabled;}
});
test('standalone VideoPass reveal retains the animate callback',async()=>{
  const {service,invoices}=setup();const prepared=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77});
  const markup={inline_keyboard:[[{text:'Animate',callback_data:prepared.video!.animate_callback_data}],[{text:'Pass',callback_data:prepared.video!.chat_offer_callback_data}]]};
  const result=await service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:prepared.video!.chat_offer_callback_data!,raw_update:{callback_query:{message:{reply_markup:markup}}}});
  assert.equal(result.commerce_ui?.step,'scene');assert.deepEqual(result.commerce_ui?.products.map(p=>p.feature_key),
    ['scene_unlock','video_unlock','video_pass','base','base','full']);
  const subscriptions=result.commerce_ui!.products.filter(p=>p.subscription_tier);
  assert.deepEqual(subscriptions.map(p=>[p.sku,p.subscription_tier,p.duration_days]),[['base','base',7],['base_long','base',60],['full','full',30]]);
  assert.deepEqual(subscriptions[0]?.prices?.map(p=>[p.source,p.amount,p.original_amount]),[['stars',100,100]]);
  assert.equal(invoices.length,0,'catalog lookup must not prepare invoice attempts');
  const chatPass=await click(service,result.commerce_ui!.products.find(product=>product.feature_key==='scene_unlock')!.callback_data!);
  assert.equal(chatPass.commerce_ui?.payment_origin_step,'scene');
  const back=await click(service,result.commerce_ui!.actions.back!);
  assert.ok(back.commerce_ui?.actions.video);assert.ok(back.commerce_ui?.actions.scene);
});

test('scene subscription catalog reuses promotions, A/B overrides and active Base upgrade rules without invoices',async(t)=>{
  const oldPromos=config.MEDIA_PROMOTIONS_JSON,oldExperiments=config.EXPERIMENTS;
  t.after(()=>{config.MEDIA_PROMOTIONS_JSON=oldPromos;config.EXPERIMENTS=oldExperiments;});
  config.MEDIA_PROMOTIONS_JSON=[{promo_key:'catalog-sale',starts_at:'2000-01-01T00:00:00Z',ends_at:'2099-01-01T00:00:00Z',
    items:[{sku:'base',promo_amount_xtr:75,promo_amount_rub:175}]}];
  config.EXPERIMENTS=[{key:'subscription_offer',version:'catalog-test',assignment_key:'subscription_offer|2000-01-01T00:00:00Z',
    starts_at:'2000-01-01T00:00:00Z',ends_at:'2099-01-01T00:00:00Z',distribution:{only:1},
    variants:{only:{plans:[{sku:'base_long',enabled:false}]}}}];
  const fresh=setup();
  const panel=await fresh.service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',panel_message_id:77});
  const catalog=await click(fresh.service,panel.commerce_ui!.actions.scene!);
  const subscriptions=catalog.commerce_ui!.products.filter(product=>product.subscription_tier);
  assert.deepEqual(subscriptions.map(product=>product.sku),['base','full']);
  assert.deepEqual(subscriptions[0]?.prices?.map(price=>[price.source,price.amount,price.original_amount]),[['stars',75,100]]);
  assert.equal(subscriptions[0]?.promo_key,'catalog-sale');assert.equal(subscriptions[0]?.callback_data,undefined);assert.equal(fresh.invoices.length,0);

  const active=setup({subscription_sku:'base_long',subscription_until:'2099-01-01T00:00:00Z'});
  const activePanel=await active.service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',panel_message_id:77});
  const activeCatalog=await click(active.service,activePanel.commerce_ui!.actions.scene!);
  const upgrade=activeCatalog.commerce_ui!.products.filter(product=>product.subscription_tier);
  assert.deepEqual(upgrade.map(product=>product.sku),['full']);
  assert.deepEqual([upgrade[0]?.subscription_change,upgrade[0]?.upgrade_base_sku],['upgrade','base_long']);
  assert.equal(active.invoices.length,0);
});

test('scene subscription entry prepares the existing offer and returns through an authorized scene callback',async()=>{
  const opened=setup();
  const panel=await opened.service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,
    scene_session_id:'scene',panel_message_id:77,panel_text:'Original panel'});
  const scene=await click(opened.service,panel.commerce_ui!.actions.scene!);
  const entry=scene.commerce_ui!.actions.subscriptions!;
  assert.equal(opened.tokens.get(entry)?.action_kind,'commerce_subscriptions');
  assert.equal(opened.invoices.length,0);

  const menu=await click(opened.service,entry);
  assert.equal(menu.operation,'subscription_offer_ready');assert.equal(menu.source,'commerce_subscriptions');
  assert.equal(menu.target_message_id,77);assert.equal(menu.panel_text,'Original panel');
  assert.deepEqual(menu.subscription_offer_items?.map(item=>item.sku),['base','base_long','full']);
  assert.ok(menu.commerce_ui?.actions.back);assert.equal(opened.tokens.get(menu.commerce_ui!.actions.back!)?.action_kind,'commerce_back');
  assert.equal(opened.invoices.length,3);
  const back=await click(opened.service,menu.commerce_ui!.actions.back!);
  assert.equal(back.commerce_ui?.step,'root');assert.ok(back.commerce_ui?.actions.video);assert.ok(back.commerce_ui?.actions.scene);

  const upgradeOnly=setup({video:null,subscription_sku:'base_long',subscription_until:'2099-01-01T00:00:00Z'});
  const upgradePanel=await upgradeOnly.service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,
    scene_session_id:'scene',panel_message_id:77});
  assert.ok(upgradePanel.commerce_ui?.actions.scene,'subscription-only catalog must remain reachable');
  const upgradeScene=await click(upgradeOnly.service,upgradePanel.commerce_ui!.actions.scene!);
  assert.deepEqual(upgradeScene.commerce_ui?.products.filter(product=>product.subscription_tier).map(product=>product.sku),['full']);
  assert.ok(upgradeScene.commerce_ui?.actions.subscriptions);assert.equal(upgradeOnly.invoices.length,0);
});

test('capabilities v1 keeps subscription choices and scene context separate',async()=>{
  const active=setup();
  const scene=await active.service.evaluate({interaction_mode:'subscription_offer',subscription_offer_reason:'subscription_command',
    idempotency_key:'cap-scene',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',commerce_capabilities_version:1,ui_origin:'active_chat'});
  assert.equal(scene.commerce_capabilities?.context.kind,'subscription');
  assert.equal(scene.commerce_capabilities?.context.scene_session_id,'scene');
  assert.ok(scene.commerce_capabilities?.controls.subscriptions);
  assert.deepEqual(scene.commerce_capabilities?.products.filter(product=>product.subscription_tier).map(product=>product.sku),
    ['base','base_long','full']);
  assert.ok(scene.commerce_capabilities?.products.filter(product=>product.subscription_tier).every(product=>product.callback_data));

  const global=setup();
  const noScene=await global.service.evaluate({interaction_mode:'subscription_offer',subscription_offer_reason:'subscription_command',
    idempotency_key:'cap-global',chat_id:1,telegram_chat_id:900,commerce_capabilities_version:1,ui_origin:'global_menu'});
  assert.equal(noScene.commerce_capabilities?.context.scene_session_id,null);
  assert.equal(noScene.commerce_capabilities?.products.some(product=>product.feature_key==='scene_unlock'||product.feature_key==='video_pass'),false);
  assert.ok(noScene.commerce_capabilities?.products.some(product=>product.subscription_tier));
});

test('scene action from a capabilities subscription keeps chat intent and origin',async()=>{
  const active=setup();
  const offer=await active.service.evaluate({interaction_mode:'subscription_offer',subscription_offer_reason:'subscription_command',
    idempotency_key:'chat-intent',chat_id:1,telegram_chat_id:900,scene_session_id:'scene',
    commerce_capabilities_version:1,ui_origin:'active_chat'});
  assert.equal(offer.commerce_capabilities?.context.kind,'subscription');
  const sceneToken=offer.commerce_ui?.actions.scene;
  assert.ok(sceneToken,'scene action must be available from the active-chat subscription menu');
  const chat=await click(active.service,sceneToken);
  assert.equal(chat.operation,'video_ui_ready');
  assert.equal(chat.ui_intent,'chat');
  assert.equal(chat.commerce_ui?.step,'scene');
  assert.ok(chat.commerce_ui?.products.some(product=>product.feature_key==='scene_unlock'));
  assert.ok(chat.commerce_ui?.products.some(product=>product.feature_key==='video_pass'));
  assert.equal(chat.commerce_capabilities?.context.kind,'subscription');
  assert.equal(chat.commerce_capabilities?.context.origin,'active_chat');
  assert.deepEqual(chat.commerce_capabilities?.products
    .filter(product=>product.feature_key==='scene_unlock'||product.feature_key==='video_pass')
    .map(product=>product.feature_key),['scene_unlock','video_pass']);
});

test('scene offer uses separate upgrade prices, original amount and server-selected variant',async(t)=>{
  const pass=config.MEDIA_ACTION_PLANS_JSON.find(item=>item.feature_key==='video_pass')!;
  const old=pass.scene_unlock_upgrade;
  const oldPromos=config.MEDIA_PROMOTIONS_JSON;
  const oldSbp=config.SBP_ENABLED;
  config.SBP_ENABLED=true;
  t.after(()=>{pass.scene_unlock_upgrade=old;config.MEDIA_PROMOTIONS_JSON=oldPromos;config.SBP_ENABLED=oldSbp;});
  config.MEDIA_PROMOTIONS_JSON=[{promo_key:'test-pass',starts_at:'2000-01-01T00:00:00Z',ends_at:'2099-01-01T00:00:00Z',
    items:[{sku:pass.sku,promo_amount_xtr:10,promo_amount_rub:20}]}];
  pass.scene_unlock_upgrade={amount_xtr:101,amount_rub:227,discount_percent:50};
  const upgraded=setup({},'paid-scene');
  const open={interaction_mode:'video_context' as const,chat_id:1,telegram_chat_id:900,scene_session_id:'scene',media_signature:'signature',panel_message_id:77,current_uuid:photoId};
  const visible=await upgraded.service.evaluate(open);
  assert.ok(visible.commerce_ui?.actions.scene);
  const response=await upgraded.service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:visible.video!.chat_offer_callback_data!});
  const passProduct=response.commerce_ui!.products.find(p=>p.feature_key==='video_pass')!;
  assert.equal(passProduct.duration_days,7);assert.deepEqual([passProduct.amount,passProduct.currency],[114,'RUB']);
  assert.deepEqual(passProduct.prices?.map(p=>[p.source,p.amount,p.original_amount,p.currency,p.discount_percent]),
    [['sbp',114,227,'RUB',50],['stars',51,101,'XTR',50]]);
  assert.equal(upgraded.invoices.length,0,'root prices do not create invoice attempts');
  upgraded.setLanguage('en');
  const selectedMarkup={inline_keyboard:[[{text:'Legacy URL',url:'https://legacy.example/checkout'}],
    [{text:'Selected',callback_data:passProduct.callback_data}]]};
  const selected=await upgraded.service.evaluate({event_type:'callback_query.received',chat_id:1,telegram_chat_id:900,
    inbound_message_id:77,callback_data:passProduct.callback_data!,raw_update:{callback_query:{from:{id:900},
      message:{message_id:77,reply_markup:selectedMarkup}}}});
  assert.equal(selected.language,'en');
  assert.equal(selected.commerce_ui?.payment_origin_step,'scene');
  assert.deepEqual(selected.commerce_ui?.return_context.reply_markup,selectedMarkup);
  assert.equal(selected.commerce_ui?.products.find(product=>product.feature_key==='video_pass')?.callback_data,passProduct.callback_data);
  for(const product of selected.commerce_ui?.products??[]){
    if(product.callback_data&&product.callback_data!==passProduct.callback_data)assert.ok(upgraded.tokens.has(product.callback_data));
  }
  assert.deepEqual(selected.commerce_ui?.products[0]?.prices,passProduct.prices);
  assert.deepEqual([selected.commerce_ui?.products[0]?.amount,selected.commerce_ui?.products[0]?.currency],[51,'XTR']);
  const option=selected.commerce_ui?.payment_options?.find(p=>p.source==='stars');
  assert.deepEqual([option?.amount,option?.original_amount,option?.discount_percent],[51,101,50]);
  const invoice=(upgraded.invoices as Array<{token:string,payload_json:Record<string,unknown>}>).find(row=>row.token===option!.token)!.payload_json;
  assert.deepEqual([invoice.purchase_variant,invoice.original_amount,invoice.final_amount,invoice.currency,invoice.discount_percent,invoice.paid_scene_unlock_token,invoice.user_id,invoice.video_id,invoice.pass_only,invoice.promo_key],
    ['scene_unlock_upgrade',101,51,'XTR',50,'paid-scene','owner',null,true,null]);
  const back=await click(upgraded.service,selected.commerce_ui!.actions.back!);
  assert.deepEqual(back.commerce_ui?.products.find(p=>p.feature_key==='video_pass')?.prices,passProduct.prices);
  assert.equal(back.scene_session_id,'scene');
  const concrete=await upgraded.service.evaluate({event_type:'callback_query.received',chat_id:1,callback_data:visible.video!.animate_callback_data!});
  await click(upgraded.service,concrete.commerce_ui!.products.find(p=>p.feature_key==='video_pass')!.callback_data!);
  const both=upgraded.invoices as Array<{token:string,payload_json:Record<string,unknown>}>;
  assert.equal(both.filter(row=>row.payload_json.feature_key==='video_pass'&&row.payload_json.video_id===videoId).length,2);
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
      assert.ok(menu.commerce_ui?.actions.scene);
      assert.ok(menu.subscription_offer_items?.some(item=>item.payment_kind==='subscription'));
      assert.ok(menu.commerce_ui?.products.some(p=>p.feature_key==='base'));
      const reveal=await service.evaluate({interaction_mode:'callback',event_type:'callback_query.received',chat_id:1,
        callback_data:menu.video!.chat_offer_callback_data!,inbound_message_id:91});
      assert.equal(reveal.target_message_id,91);assert.equal(reveal.commerce_ui?.step,'scene');
      assert.deepEqual(reveal.commerce_ui?.products.map(p=>p.feature_key),available
        ? ['scene_unlock','video_pass','base','base','full']
        : ['scene_unlock','base','base','full']);
    }
  }
});

test('Web chat with Base can still buy a VideoPass; active subscriptions remove redundant Scene Unlock',async()=>{
  const base=await setup({subscription_sku:'base',subscription_until:'2099-01-01T00:00:00Z'}).service.webProductPlans(1);
  assert.equal(base.some(p=>p.feature_key==='scene_unlock'),false);assert.ok(base.some(p=>p.feature_key==='video_pass'));
  const full=await setup({subscription_sku:'full',subscription_until:'2099-01-01T00:00:00Z',full_active:true}).service.webProductPlans(1);
  assert.equal(full.some(p=>p.feature_key==='video_pass'||p.feature_key==='scene_unlock'),false);
});

test('photo checkout preserves the selected photo, quote and sibling intent for allowed RU and EN methods',async(t)=>{
  const oldSbp=config.SBP_ENABLED,oldUrl=config.GATEWAY_PUBLIC_URL;
  config.SBP_ENABLED=true;config.GATEWAY_PUBLIC_URL='https://merchant.invalid';
  t.after(()=>{config.SBP_ENABLED=oldSbp;config.GATEWAY_PUBLIC_URL=oldUrl;});
  for(const language of ['ru','en'] as const){
    const {service,tokens,invoices}=setup({},null,language);
    const row=(token:string,action_kind:string,payload_json:Record<string,unknown>):InteractionTokenRow=>({
      token,action_kind,payload_json,kind:'button_callback',chat_id:1,scene_session_id:'scene',turn_no:2,status:'active',expires_at:null,
    });
    const photo=row('original','free_photo_unlock',{photo_sku:'photo',media_signature:'signature',target_message_id:77,current_uuid:photoId,
      base_price_xtr:100,requested_action:'photo_regen'});
    const open=row('select','commerce_photo_pay',{surface:'daily_photos',user_id:'owner',telegram_chat_id:900,target_message_id:77,
      media_signature:'signature',source_photo:photoId,photo_token:photo.token});
    tokens.set(photo.token,photo);tokens.set(open.token,open);
    const payment=await click(service,open.token);
    assert.equal(payment.commerce_ui?.step,'payment');
    assert.equal(payment.commerce_ui?.payment_origin_step,undefined);
    const options=payment.commerce_ui!.payment_options!;
    assert.deepEqual(options.map(o=>o.source).sort(),['sbp','stars']);
    assert.deepEqual(payment.commerce_ui!.products[0]!.prices?.slice().sort((a,b)=>a.source.localeCompare(b.source)).map(p=>[p.source,p.amount,p.currency]),
      [['sbp',230,'RUB'],['stars',100,'XTR']]);
    for(const opt of options){
      const snapshot=(invoices as Array<{token:string,payload_json:Record<string,unknown>}>).find(row=>row.token===opt.token)!.payload_json;
      assert.equal(snapshot.current_uuid,photoId);assert.equal(snapshot.target_message_id,77);assert.equal(snapshot.scene_session_id,'scene');
      assert.equal(snapshot.idempotency_key,'photo-unlock-click:'+photo.token);
      if(opt.source==='sbp'){assert.equal(opt.amount,230);assert.match(opt.checkout_url,/^https:\/\/merchant\.invalid\/v1\/pay\/sbp\//);}
      else assert.equal(opt.amount,100);
    }
  }
});

test('root and payment prices exclude disabled SBP or absent RUB for either Telegram locale',async(t)=>{
  const oldSbp=config.SBP_ENABLED,oldPlans=config.MEDIA_ACTION_PLANS_JSON;
  t.after(()=>{config.SBP_ENABLED=oldSbp;config.MEDIA_ACTION_PLANS_JSON=oldPlans;});
  for(const unavailable of ['disabled','missing-rub'] as const){
    config.SBP_ENABLED=unavailable!=='disabled';
    config.MEDIA_ACTION_PLANS_JSON=oldPlans.map(plan=>({...plan,
      ...(unavailable==='missing-rub'?{amount_rub:null}:{}),
    }));
    for(const language of ['ru','en'] as const){
      const {service,invoices}=setup({},null,language);
      const panel=await service.evaluate({interaction_mode:'video_context',chat_id:1,telegram_chat_id:900,
        scene_session_id:'scene',media_signature:'signature',panel_message_id:77,current_uuid:photoId});
      const offer=await click(service,panel.video!.chat_offer_callback_data!);
      assert.ok(offer.commerce_ui!.products.length>0);
      for(const product of offer.commerce_ui!.products.filter(product=>!product.subscription_tier)){
        assert.deepEqual(product.prices?.map(p=>p.source),['stars']);
        assert.equal(product.currency,'XTR');
      }
      const subscriptionSources=offer.commerce_ui!.products.find(product=>product.subscription_tier)?.prices?.map(p=>p.source);
      assert.deepEqual(subscriptionSources,unavailable==='disabled'?['stars']:['sbp','stars']);
      assert.equal(invoices.length,0);
      const product=offer.commerce_ui!.products.find(p=>p.feature_key==='video_pass')!;
      const payment=await click(service,product.callback_data!);
      assert.deepEqual(payment.commerce_ui?.payment_options?.map(p=>p.source),['stars']);
      const amounts=(prices:typeof product.prices)=>prices?.map(p=>[p.source,p.amount,p.original_amount,p.currency,p.discount_percent??0]);
      assert.deepEqual(amounts(payment.commerce_ui?.products[0]?.prices),amounts(product.prices));
    }
  }
});
