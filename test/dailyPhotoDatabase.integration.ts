import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {installTestEnv,testTelegramUxCopy} from './testEnv.js';

test('three ordinary free receipts survive a same-day scene reset', async t => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname) && url.pathname.includes('test'));
  installTestEnv();
  process.env.DATABASE_URL=url.href;
  process.env.MEDIA_VIDEO_ENABLED='false';
  const plan={sku:'daily-photo',amount_xtr:12,title:'Test',label:'Test',description:'Test',button_text:'Test'};
  process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...plan,sku:'daily-scene',feature_key:'scene_unlock'}]);
  process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([plan]);
  process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...plan,sku:'daily-base',days:30}]);
  const [{MediaCommerceDecisionService},{MediaCommerceRepository}] = await Promise.all([
    import('../src/mediaCommerceDecisionService.js'),import('../src/mediaCommerceRepository.js')
  ]);
  const db = postgres(url.href,{max:2,onnotice:()=>{}});
  t.after(() => db.end());
  const [account] = await db`INSERT INTO users(display_name) VALUES('quota fixture') RETURNING user_id`;
  const one = randomUUID(), two = randomUUID(), hint = 'daily-'+randomUUID();
  const [chat] = await db`INSERT INTO chat_state(user_id,character_i,source,active_scene_session_id)
    VALUES(${account!.user_id},1,'telegram',${one}) RETURNING chat_id`;
  const chatId = Number(chat!.chat_id);
  await db`INSERT INTO chat_scene_sessions(chat_id,scene_session_id) VALUES(${chatId},${one}),(${chatId},${two})`;
  const repo = new MediaCommerceRepository(db);
  for (let i=0;i<3;i++) {
    await repo.storePhotoEvent({chat_id:chatId,scene_session_id:one,turn_no:i,scene_turn_no:i,
      media_signature:hint,uuid:randomUUID(),panel_message_id:77,price_xtr:0,event_type:'media.photo.unlocked.free',
      access_mode:'free',action_kind:'photo_request',fulfillment_invoice_token:null,next_invoice_token:null,next_invoice_link:null,price_required:0});
  }
  await db`UPDATE chat_state SET active_scene_session_id=${two} WHERE chat_id=${chatId}`;
  const result=await new MediaCommerceDecisionService(repo,undefined,null,undefined,undefined,
    {async getTelegramCopy(){return testTelegramUxCopy;}}).evaluate({interaction_mode:'prepare_offer',
    chat_id:chatId,scene_session_id:two,turn_no:4,scene_turn_no:0,base_price_xtr:12,media_signature:hint,should_offer:false});
  assert.equal(result.price_required,12,'a scene reset must not restore free photos');
  await t.test('message usage follows the Moscow date and selected dialogue, excluding commands',async()=>{
    const {ChatAccessRepository}=await import('../src/chatAccessRepository.js');
    const access=new ChatAccessRepository(db);
    const transport=parseInt(randomUUID().slice(0,8),16)+10_000_000;
    const load=(character:number)=>access.ensureAndLoadAccessContext(transport,'telegram',transport,'Europe/Moscow',character,true);
    const first=await load(1);
    const scene=randomUUID();
    await db`INSERT INTO chat_scene_sessions(chat_id,character_i,scene_session_id) VALUES(${first.chat_id},1,${scene})`;
    for(const [i,[type,ms]] of ([['text',-1],['text',0],['command',1]] as const).entries()){
      await db`INSERT INTO chat_turns(chat_id,scene_session_id,n,message_type,created_at)
        VALUES(${first.chat_id},${scene},${i+1},${type},
        ((now() AT TIME ZONE 'Europe/Moscow')::date::timestamp AT TIME ZONE 'Europe/Moscow')+
        ${ms}::int*interval '1 millisecond')`;
    }
    assert.equal((await load(1)).turns_today,1);
    assert.equal((await load(2)).turns_today,0);
    assert.equal((await load(1)).turns_today,1);
  });
  await t.test('Moscow midnight counts confirmed ordinary unlocks once and excludes credit, paid and subscription', async () => {
    const uuid=randomUUID(),day1='2030-01-14T20:59:59.999Z',day2='2030-01-14T21:00:00.000Z';
    for(const [index,[type,mode,photo,ts]] of [
      ['free','free',uuid,day1],['free','free',uuid,day1],['viewed.nav','nav',uuid,day2],
      ['free','free_credit',randomUUID(),day2],['subscription','subscription',randomUUID(),day2],
      ['paid','paid',randomUUID(),day2],['scene_pass','scene_pass',randomUUID(),day2],
      ['free','free',randomUUID(),day2]
    ].entries()){
      const event=type==='viewed.nav'?'media.photo.viewed.nav':'media.photo.unlocked.'+type;
      await db`INSERT INTO chat_messages(chat_id,scene_session_id,turn_no,seq_in_turn,event_type,created_at,payload_json)
        VALUES(${chatId},${two},${index+6},1,${event},${ts!}::timestamptz,${db.json({uuid:photo!,access_mode:mode!})})`;
    }
    const count=async(at:string)=>(await db`SELECT confirmed FROM app_private.daily_photo_usage(${chatId},${at}::timestamptz)`)[0]!.confirmed;
    assert.equal(await count(day1),1);
    assert.equal(await count(day2),1);
    assert.equal(await count('2030-01-15T21:00:00Z'),0);
  });
  await t.test('two different photo requests compete for one slot; a retry and an old view cost nothing extra', async () => {
    const [other]=await db`INSERT INTO chat_state(user_id,character_i,source,active_scene_session_id)
      VALUES(${account!.user_id},2,'telegram',${randomUUID()}) RETURNING chat_id,active_scene_session_id`;
    const id=Number(other!.chat_id),scene=other!.active_scene_session_id as string;
    await db`INSERT INTO chat_scene_sessions(chat_id,character_i,scene_session_id) VALUES(${id},2,${scene})`;
    const photos=[randomUUID(),randomUUID()];
    const claim=async(i:number)=>(await db`SELECT app_private.authorize_daily_photo(${id},${scene},${'callback-'+i},${photos[i]!},${88+i},1) mode`)[0]!.mode;
    const result=await Promise.all([claim(0),claim(1)]);
    const winner=result.indexOf('free');
    assert.notEqual(winner,-1); assert.equal(result.filter(x=>x==='free').length,1);
    assert.equal(await claim(winner),'free');
    assert.deepEqual({...((await db`SELECT * FROM app_private.daily_photo_usage(${id})`)[0])},{confirmed:0,pending:1});
    const store=async(i:number)=>db`SELECT * FROM public.media_store_photo_event(${id},${scene},0,0,
      'media.photo.unlocked.free','fixture',${photos[i]!},${88+i},0,'free','photo_request',null,null,null,1,1)`;
    await assert.rejects(store(1-winner),/daily_photo_limit/);
    await store(winner);await store(winner);
    assert.equal(await claim(winner),'nav');
    assert.deepEqual({...((await db`SELECT * FROM app_private.daily_photo_usage(${id})`)[0])},{confirmed:1,pending:0});
  });
  await t.test('an abandoned claim expires and can retry only its own photo; a late receipt cannot exceed the quota',async()=>{
    const id=chatId, first=randomUUID(),second=randomUUID();
    const claim=async(key:string,photo:string)=>(await db`SELECT app_private.authorize_daily_photo(${id},${two},${key},${photo},78,4) AS mode`)[0]!.mode;
    assert.equal(await claim('old',first),'free');
    const [hold]=await db`SELECT expires_at-created_at <= interval '181 seconds' AS bounded FROM interaction_tokens
      WHERE chat_id=${id} AND action_kind='daily_photo_reservation' AND payload_json->>'photo'=${first}`;
    assert.equal(hold!.bounded,true);
    const expire=()=>db`UPDATE interaction_tokens SET expires_at=clock_timestamp()-interval '1 second'
      WHERE chat_id=${id} AND action_kind='daily_photo_reservation' AND payload_json->>'photo'=${first}`;
    await expire();
    assert.equal(await claim('old',second),null);
    assert.equal(await claim('old',first),'free');
    await expire();
    assert.equal(await claim('next',second),'free');
    assert.equal(await claim('old',first),null);
    const save=(photo:string)=>db`SELECT * FROM public.media_store_photo_event(${id},${two},20,1,'media.photo.unlocked.free',
        'retry',${photo},78,0,'free','photo_request',null,null,null,4,4)`;
    await save(second);await assert.rejects(save(first),/daily_photo_limit/);
  });
});
