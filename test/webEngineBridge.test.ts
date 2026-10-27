import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { installTestEnv } from './testEnv.js';
import { WebError } from '../src/web/types.js';

process.env.NODE_ENV='test';
installTestEnv();
const plan={sku:'fixture',amount_xtr:10,title:'Fixture',description:'Fixture',label:'Fixture',button_text:'Fixture'};
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON??=JSON.stringify([{...plan,days:1}]);
process.env.MEDIA_PHOTO_PLANS_JSON??=JSON.stringify([plan]);
process.env.MEDIA_ACTION_PLANS_JSON??=JSON.stringify([{...plan,feature_key:'scene_unlock'}]);
const {registerWebEngineRoutes}=await import('../src/web/engineBridge.js');
const {config}=await import('../src/config.js');
const headers={[config.INTERNAL_API_KEY_HEADER.toLowerCase()]:config.INTERNAL_API_KEY};

test('engine bridge rejects public Bearer credentials and validates transport/context identifiers',async t=>{
 const calls:unknown[]=[];
 const bridge={async context(id:number){calls.push(id);return {chat_id:id};},async mediaOffer(input:unknown){calls.push(input);return {offered:false};},async continuation(input:unknown){calls.push(input);return {action:'none'};}};
 const app=Fastify({logger:false});
 registerWebEngineRoutes(app,bridge as unknown as import('../src/web/engineBridge.js').WebEngineBridge);
 t.after(()=>app.close());
 for(const url of ['/v1/web/engine-context','/v1/web/media-offer','/v1/web/continuation']){
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer browser-token'},payload:{}})).statusCode,401);
 }
 assert.deepEqual(calls,[]);
 assert.equal((await app.inject({method:'POST',url:'/v1/web/engine-context',headers,payload:{chat_id:Number.MAX_SAFE_INTEGER+1}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/v1/web/media-offer',headers,payload:{chat_id:42,sku:'photo',media_signature:'garden_close_standing_clothed_front',debounce_revision:-1}})).statusCode,400);
 const result=await app.inject({method:'POST',url:'/v1/web/continuation',headers,payload:{telegram_chat_id:42,source_user_id:43,confirm:true,scene_session_id:'scene',turn_no:2}});
 assert.equal(result.statusCode,200);
 assert.equal(result.json().action,'none');
 assert.equal(calls.length,1);
});

test('engine bridge exposes expected conflicts while hiding SQL and upstream error details',async t=>{
 const app=Fastify({logger:false});
 registerWebEngineRoutes(app,{async context(){throw new Error('private connection or prompt material');},async mediaOffer(){throw new WebError(409,'stale_scene');}} as unknown as import('../src/web/engineBridge.js').WebEngineBridge);
 t.after(()=>app.close());
 const failure=await app.inject({method:'POST',url:'/v1/web/engine-context',headers,payload:{chat_id:42}});
 assert.equal(failure.statusCode,500);
 assert.deepEqual(failure.json(),{error:'engine_bridge_failed'});
 const stale=await app.inject({method:'POST',url:'/v1/web/media-offer',headers,payload:{chat_id:42,sku:'photo',media_signature:'garden_close_standing_clothed_front'}});
 assert.equal(stale.statusCode,409);
 assert.deepEqual(stale.json(),{error:'stale_scene'});
});
