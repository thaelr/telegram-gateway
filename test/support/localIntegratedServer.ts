/** Local browser fixture: real HTTP routes/repositories/Postgres, synthetic Auth/payment transport.
 * Never load production credentials. Database must be a dedicated loopback test database.
 */
import {writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {installTestEnv} from '../testEnv.js';

const database=process.env.TEST_DATABASE_URL;
if(!database)throw new Error('TEST_DATABASE_URL required');
const target=new URL(database);
if(!['127.0.0.1','localhost'].includes(target.hostname)||target.pathname!=='/mp_v31_browser_test')throw new Error('Dedicated local browser database required');
process.env.NODE_ENV='test';
process.env.DATABASE_URL=database;
process.env.INTERNAL_API_KEY='local-integrated-fixture-key';
process.env.WEB_ENABLED='false';
process.env.WEB_ALLOWED_ORIGINS='http://127.0.0.1:5177';
process.env.SBP_ENABLED='false';
process.env.NOWPAYMENTS_ENABLED='false';
process.env.TG_BOT_TOKEN='local-fixture-no-external-telegram';
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{sku:'browser_base',title:'Fixture Base',description:'Neutral local plan',label:'Base',button_text:'Buy',amount_xtr:10,amount_rub:100,days:30}]);
process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{sku:'browser_photo',title:'Fixture Photo',description:'Neutral local photo',label:'Photo',button_text:'Buy',amount_xtr:10,amount_rub:100}]);
process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{sku:'browser_skip',feature_key:'fast_scene_skip',title:'Fixture Skip',description:'Neutral local action',label:'Skip',button_text:'Buy',amount_xtr:10,amount_rub:100}]);
installTestEnv();
// Any accidentally reached external transport fails closed in this test process.
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 if(!['127.0.0.1','localhost'].includes(url.hostname))return Promise.reject(new Error('External network disabled in local fixture'));
 return nativeFetch(input,init);
};
const [{sql},{WebRepository},{WebFeaturesRepository},{LocalizationService},{LocalizationRepository},{buildApp},{WebAuthError},{WebCommerceService},{WebCommerceRepository},{PaymentProviderRegistry},{MediaCommerceDecisionService},{MediaCommerceRepository},{WebDeliveryWorker,createWebDeliveryTransport}]=await Promise.all([
 import('../../src/db.js'),import('../../src/modules/chats/webRepository.js'),import('../../src/web/featuresRepository.js'),import('../../src/localization.js'),import('../../src/localizationRepository.js'),import('../../src/server.js'),import('../../src/web/auth.js'),import('../../src/web/commerce.js'),import('../../src/modules/commerce/webPurchaseRepository.js'),import('../../src/payments/providers.js'),import('../../src/application/mediaCommerceDecision.js'),import('../../src/application/mediaCommerceRepository.js'),import('../../src/web/delivery.js'),
]);
await sql`UPDATE public.characters SET name='Neutral character '||character_i::text,description='Neutral local fixture',description_translations_json='{"en":"Neutral local fixture","ru":"Нейтральная тестовая запись"}',gallery_photo_url=NULL,menu_photo_url=NULL,gallery_photo_urls_json='{}',menu_photo_urls_json='{}',scene_start_exposition_text='A neutral test room.',scene_start_greeting_text='Hello from the local fixture.',scene_start_exposition_translations_json='{"en":"A neutral test room.","ru":"Тестовая комната."}',scene_start_greeting_translations_json='{"en":"Hello from the local fixture.","ru":"Тестовое приветствие."}',fast_mode_scene_start_exposition_text='A neutral test room.',fast_mode_scene_start_greeting_text='Hello from the local fixture.',fast_mode_scene_start_exposition_translations_json='{"en":"A neutral test room.","ru":"Тестовая комната."}',fast_mode_scene_start_greeting_translations_json='{"en":"Hello from the local fixture.","ru":"Тестовое приветствие."}'`;
const repository=new WebRepository();
const authId=process.env.LOCAL_FIXTURE_AUTH_ID??randomUUID();
const profile=await repository.bootstrap({auth_user_id:authId,is_anonymous:true,display_name:'Local browser reader',locale:'en'});
await repository.updateMe(profile.user_id,{language:'en'});
await repository.confirmAge(profile.user_id);await repository.acceptTerms(profile.user_id);
const expires=Math.floor(Date.now()/1000)+36000;
const accessToken=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:authId,exp:expires})).toString('base64url')+'.local-fixture';
const localization=new LocalizationService(new LocalizationRepository(),{characterGalleryOrder:[1],characterVoteUrl:''});
let providerCreates=0;
const providers=new PaymentProviderRegistry([{id:'sbp',platforms:['web'],async create(input){providerCreates++;return {external_id:input.attempt_id,external_kind:'payment',checkout_url:'https://payments.invalid/fixture/'+input.attempt_id,expires_at:null};}}]);
// Only provider availability is synthetic; prices/quote/dedupe/persistence remain real.
const commerce=new WebCommerceService(new WebCommerceRepository(),providers,new MediaCommerceDecisionService(new MediaCommerceRepository(),undefined,undefined,undefined,undefined,localization),repository,{
 getNamespace:localization.getNamespace.bind(localization),getExactNamespace:localization.getExactNamespace.bind(localization),getTelegramCopy:localization.getTelegramCopy.bind(localization),getPaymentMethods:async()=>['sbp'],
});
const worker=process.env.LOCAL_N8N_URL?new WebDeliveryWorker({store:repository,transport:createWebDeliveryTransport({url:process.env.LOCAL_N8N_URL,secret:'local-web-fixture-secret',timeoutMs:10000,allowLoopbackHttp:true}),maxAttempts:3,leaseMs:30000,pollMs:300}):undefined;
const app=buildApp({logger:false,localizationService:localization,web:{repository,localization,features:new WebFeaturesRepository(repository),commerce,...(worker?{deliveryWorker:worker}:{}),authenticator:{async verify(header){if(header!=='Bearer '+accessToken)throw new WebAuthError(401,'invalid_session');return {auth_user_id:authId,is_anonymous:true,display_name:'Local browser reader',locale:'en'};}}}});
app.get('/fixture/metrics',async()=>({providerCreates,worker:Boolean(worker)}));
await app.listen({host:'127.0.0.1',port:55451});
const fixture={authId,userId:profile.user_id,accessToken,expires,gateway:'http://127.0.0.1:55451',database:target.pathname.slice(1),worker:Boolean(worker)};
const evidenceRoot=resolve(existsSync('../DELIVERY_MANIFEST.json')?'../verification':'../../verification');
await writeFile(resolve(evidenceRoot,'browser-fixture.json'),JSON.stringify(fixture,null,2));
console.log('Local integrated Gateway ready on 127.0.0.1:55451; synthetic Auth/payment adapter; real PostgreSQL.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void(async()=>{await app.close();await sql.end({timeout:5});process.exit(0);})();});
