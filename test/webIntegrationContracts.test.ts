import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import {registerWebCors} from '../src/web/cors.js';
import {decodeHistoryCursor,encodeHistoryCursor,mapHistoryMessage} from '../src/web/history.js';
import {installTestEnv} from './testEnv.js';

process.env.NODE_ENV='test';installTestEnv();
const testPlan={sku:'fixture',amount_xtr:10,amount_rub:100,title:'Fixture',description:'Neutral test',label:'Fixture',button_text:'Buy'};
process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...testPlan,days:30}]);
process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([testPlan]);
process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...testPlan,feature_key:'scene_unlock'}]);
const {WebRepository}=await import('../src/modules/chats/webRepository.js');

test('browser CORS preflight permits only configured origins and required headers without bypassing bearer authorization',async(t)=>{
 const app=Fastify();t.after(()=>app.close());registerWebCors(app,['https://frontend.example']);
 app.get('/web/private',async(request,reply)=>{reply.header('Vary','Authorization');if(request.headers.authorization!=='Bearer good')return reply.status(401).send({error:'unauthorized'});return {ok:true};});
 app.get('/v1/private',async()=>({ok:true}));
 const origin={origin:'https://frontend.example'};
 const preflight=await app.inject({method:'OPTIONS',url:'/web/private',headers:{...origin,'access-control-request-method':'GET','access-control-request-headers':'authorization, content-type'}});
 assert.equal(preflight.statusCode,204);assert.equal(preflight.headers['access-control-allow-origin'],origin.origin);
 assert.equal(preflight.headers['access-control-allow-credentials'],undefined);
 assert.equal((await app.inject({url:'/web/private',headers:origin})).statusCode,401);
 const response=await app.inject({url:'/web/private',headers:{...origin,authorization:'Bearer good'}});
 assert.equal(response.statusCode,200);assert.match(String(response.headers.vary),/Authorization/);assert.match(String(response.headers.vary),/Origin/);
 assert.equal((await app.inject({url:'/web/private',headers:{origin:'https://attacker.example',authorization:'Bearer good'}})).statusCode,403);
 assert.equal((await app.inject({method:'OPTIONS',url:'/web/private',headers:{...origin,'access-control-request-method':'DELETE'}})).statusCode,403);
 assert.equal((await app.inject({method:'OPTIONS',url:'/web/private',headers:{...origin,'access-control-request-method':'POST','access-control-request-headers':'x-internal-key'}})).statusCode,403);
 assert.equal((await app.inject({url:'/v1/private',headers:origin})).headers['access-control-allow-origin'],undefined);
});

test('history cursors preserve microseconds and media messages expose stable delivery IDs, never storage details',()=>{
 const row={id:'v:33333333-3333-4333-8333-333333333333',role:'assistant',text:'',source:'web',scene_session_id:'scene-a',turn_no:4,created_text:'2026-11-03 10:20:30.123456+00',media_kind:'video',media_id:'22222222-2222-4222-8222-222222222222',video_delivery_id:'33333333-3333-4333-8333-333333333333',bucket_name:'private',storage_path:'private.mp4'};
 assert.deepEqual(decodeHistoryCursor(encodeHistoryCursor(row)),[row.created_text,row.id]);
 const message=mapHistoryMessage(row);assert.equal(message.video_delivery_id,row.video_delivery_id);assert.equal(message.id,row.id);assert.equal(message.text,'');assert.equal('storage_path' in message,false);assert.equal('bucket_name' in message,false);
 assert.throws(()=>decodeHistoryCursor(Buffer.from(JSON.stringify([2,'invalid',row.id])).toString('base64url')),{code:'invalid_history_cursor'});
});

test('reset binds selected mode to its persisted operation, retries after scene change and rejects an ID reused with another mode',async()=>{
 let saved:any=null;let inserts=0;let activeMode='roleplay';
 const db:any={begin:async(fn:any)=>fn(db),unsafe:async(statement:string,args:any[])=>{
  if(statement.includes('SELECT user_id FROM public.users'))return [{user_id:'u0000001'}];
  if(statement.includes('FROM public.user_identities'))return [{exists:1}];
  if(statement.includes('FROM public.chat_state'))return [{chat_id:1,chat_code:'c0000001',character_i:1,scene_mode:activeMode,scene_session_id:'scene-a',turn_no:3,scene_turn_no:2,updated_at:'2026-11-03T00:00:00Z'}];
  if(statement.includes('SELECT language_confirmed_at'))return [{language_confirmed_at:'2026-11-03',age_confirmed_at:'2026-11-03',terms_accepted_at:'2026-11-03'}];
  if(statement.includes("SELECT envelope->>'scene_mode'"))return saved?[{mode:saved.envelope.scene_mode}]:[];
  if(statement.includes('SELECT * FROM app_private.web_operations'))return saved?[saved]:[];
  if(statement.includes('INSERT INTO app_private.web_operations')){inserts++;saved={event_id:args[0],action:args[4],fingerprint:args[5],envelope:JSON.parse(args[6]),status:'accepted'};return [saved];}
  if(statement.includes('INSERT INTO app_private.web_activity'))return [];
  throw new Error('Unexpected test query');
 }};
 const repo=new WebRepository(db);
 const first=await repo.enqueue('u0000001','c0000001','reset','same',undefined,'fast');assert.equal(saved.envelope.scene_mode,'fast');
 activeMode='fast';assert.deepEqual(await repo.enqueue('u0000001','c0000001','reset','same',undefined,'fast'),first);
 activeMode='roleplay';assert.deepEqual(await repo.enqueue('u0000001','c0000001','reset','same'),first);
 await assert.rejects(repo.enqueue('u0000001','c0000001','reset','same',undefined,'roleplay'),{code:'idempotency_conflict'});assert.equal(inserts,1);
 saved.fingerprint=createHash('sha256').update(JSON.stringify({action:'reset',data:{client_message_id:'same'}})).digest('hex');
 assert.deepEqual(await repo.enqueue('u0000001','c0000001','reset','same',undefined,'fast'),first);assert.equal(inserts,1);
});
