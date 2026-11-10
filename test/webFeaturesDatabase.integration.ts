import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {installTestEnv} from './testEnv.js';

test('Web feature repositories use the actual isolated SQL contracts',async t=>{
 const url=process.env.TEST_DATABASE_URL;if(!url)throw new Error('TEST_DATABASE_URL required');
 const parsed=new URL(url);assert.ok(['127.0.0.1','localhost'].includes(parsed.hostname)&&parsed.pathname.includes('test'),'Local isolated test database required');
 process.env.NODE_ENV='test';process.env.DATABASE_URL=url;installTestEnv();
 const invoice={title:'Test',description:'Neutral test',label:'Test',button_text:'Buy',amount_xtr:10,amount_rub:100};
 process.env.MEDIA_SUBSCRIPTION_PLANS_JSON=JSON.stringify([{...invoice,sku:'test_base',days:30}]);
 process.env.MEDIA_PHOTO_PLANS_JSON=JSON.stringify([{...invoice,sku:'test_photo'}]);
 process.env.MEDIA_ACTION_PLANS_JSON=JSON.stringify([{...invoice,sku:'test_skip',feature_key:'fast_scene_skip'}]);
 const [{WebRepository},{WebFeaturesRepository},{linkHash}]=await Promise.all([import('../src/modules/chats/webRepository.js'),import('../src/web/featuresRepository.js'),import('../src/web/telegramLink.js')]);
 const db=postgres(url,{max:6,prepare:false,onnotice:()=>{}});t.after(()=>db.end());
 const accounts=new WebRepository(db),features=new WebFeaturesRepository(accounts,db);
 const owner=async()=>{const authId=randomUUID();const p=await accounts.bootstrap({auth_user_id:authId,is_anonymous:true,display_name:'Neutral test',locale:'en'});await accounts.updateMe(p.user_id,{language:'en'});await accounts.confirmAge(p.user_id);await accounts.acceptTerms(p.user_id);return {id:p.user_id,authId};};
 const user=await owner(),other=await owner();
 const {chat}=await accounts.createChat(user.id,1,'roleplay',randomUUID());
 const [state]=await db`SELECT chat_id FROM public.chat_state WHERE chat_code=${chat.chat_code}`;const chatId=Number(state!.chat_id);
 await t.test('unread and read cursor match durable history without timestamp-tie loss',async()=>{
  const [first]=await db`INSERT INTO public.chat_messages(chat_id,sender_type,event_type,message_text,source,turn_no,seq_in_turn,created_at) VALUES(${chatId},'assistant','scene.start.greeting','Neutral one','web',1,1,clock_timestamp()-interval '2 minutes') RETURNING id,created_at::text`;
  const [second]=await db`INSERT INTO public.chat_messages(chat_id,sender_type,event_type,message_text,source,turn_no,seq_in_turn,created_at) VALUES(${chatId},'assistant','scene.start.greeting','Neutral two','web',2,1,(SELECT created_at FROM public.chat_messages WHERE id=${first!.id})) RETURNING id`;
  const before=(await features.summaries(user.id)).chats.find(c=>c.chat_code===chat.chat_code)!;
  assert.equal(before.unread_count,2);assert.ok(before.last_message);
  const ids=[`m:${first!.id}`,`m:${second!.id}`].sort();
  await features.markRead(user.id,chat.chat_code,ids[0]!);
  assert.equal((await features.summaries(user.id)).chats.find(c=>c.chat_code===chat.chat_code)!.unread_count,1);
  await features.markRead(user.id,chat.chat_code,ids[1]!);
  await features.markRead(user.id,chat.chat_code,ids[0]!);
  const after=(await features.summaries(user.id)).chats.find(c=>c.chat_code===chat.chat_code)!;
  assert.equal(after.unread_count,0);assert.equal(after.last_read_message_id,ids[1]);
  await assert.rejects(features.markRead(other.id,chat.chat_code,ids[1]!),{code:'chat_not_found'});
  await assert.rejects(features.markRead(user.id,chat.chat_code,'m:999999999999'),{code:'message_not_found'});
 });
 await t.test('publications exclude scheduled content and use stable paginated identifiers',async()=>{
  const [p]=await db`SELECT app_private.publish_web_publication('{"en":"Neutral published"}','{"en":"Neutral body"}',clock_timestamp()) AS id`;
  const [future]=await db`SELECT app_private.publish_web_publication('{"en":"Scheduled test"}','{"en":"Neutral scheduled body"}',clock_timestamp()+interval '1 day') AS id`;
  const page=await features.publications(user.id,undefined,1);
  assert.equal(page.posts[0]!.id,String(p!.id));assert.equal(page.posts[0]!.title,'Neutral published');
  assert.ok(!(await features.publications(user.id)).posts.some(post=>post.id===String(future!.id)));
  if(page.next_before)assert.ok(!(await features.publications(user.id,page.next_before)).posts.some(post=>post.id===String(p!.id)));
  await assert.rejects(features.publications(user.id,'bad'),{code:'invalid_publication_cursor'});
 });
 await t.test('campaign choices persist and same vote retries do not create duplicates',async()=>{
  const campaign=randomUUID(),candidate=randomUUID(),second=randomUUID();
  await db`INSERT INTO mp_campaign.voting_campaigns(campaign_id,title_translations,status,starts_at) VALUES(${campaign},${db.json({en:'Neutral voting'})},'active',clock_timestamp())`;
  await db`INSERT INTO mp_campaign.voting_candidates(candidate_id,campaign_id,name_translations) VALUES(${candidate},${campaign},${db.json({en:'Candidate one'})}),(${second},${campaign},${db.json({en:'Candidate two'})})`;
  try{
   assert.equal((await features.voting(user.id)).campaign!.id,campaign);
   await features.castVote(user.id,campaign,candidate);await features.castVote(user.id,campaign,candidate);
   assert.equal((await features.voting(user.id)).campaign!.selected_candidate_id,candidate);
   await assert.rejects(features.castVote(user.id,campaign,second),{code:'vote_conflict'});
   assert.equal(Number((await db`SELECT count(*) AS n FROM mp_campaign.votes WHERE campaign_id=${campaign} AND user_id=${user.id}`)[0]!.n),1);
  }finally{await db`UPDATE mp_campaign.voting_campaigns SET status='closed' WHERE campaign_id=${campaign}`;}
 });
 await t.test('Telegram challenge binds session/account, persists only digests, supports retry',async()=>{
  const nonce=randomUUID(),hash=linkHash(nonce),proofHash=linkHash(randomUUID());
  await features.issueTelegramChallenge(user.id,user.authId,hash);
  await assert.rejects(features.telegramChallenge(other.id,other.authId,hash),{code:'telegram_link_expired'});
  assert.equal((await features.telegramChallenge(user.id,user.authId,hash)).user_id,user.id);
  const telegramId=String(Math.floor(Math.random()*1_000_000_000)+1_000_000_000);
  const linked=await features.completeTelegramLink(user.id,user.authId,hash,telegramId,proofHash);
  assert.deepEqual(linked,{linked:true,user_id:user.id});
  assert.deepEqual(await features.completeTelegramLink(user.id,user.authId,hash,telegramId,proofHash),linked);
  assert.deepEqual(await features.telegramStatus(user.id),{linked:true,telegram_user_id:telegramId});
  await assert.rejects(features.completeTelegramLink(user.id,user.authId,hash,telegramId,linkHash('other')),{code:'telegram_link_used'});
 });
 await t.test('concurrent account adoption rejects late chat/profile/consent writes to the detached Web account',async()=>{
  const source=await owner(),telegramId=String(Math.floor(Math.random()*1_000_000_000)+3_000_000_000);
  const [target]=await db`INSERT INTO public.users(display_name) VALUES('Existing Telegram account') RETURNING user_id`;
  await db`INSERT INTO public.user_identities(user_id,provider,external_id) VALUES(${target!.user_id},'telegram',${telegramId})`;
  const hash=linkHash(randomUUID()),proof=linkHash(randomUUID());await features.issueTelegramChallenge(source.id,source.authId,hash);
  let attempts:Promise<{error?:unknown;value?:unknown}>[]=[];
  await db.begin(async tx=>{
   const [linked]=await tx`SELECT app_private.web_complete_telegram_link(${source.id}::varchar,${source.authId},${hash},${telegramId},${proof}) AS result`;
   assert.equal(linked!.result.user_id,target!.user_id);
   const mutations=[()=>accounts.createChat(source.id,1,'fast',randomUUID()),()=>accounts.updateMe(source.id,{display_name:'Must not be orphaned'}),()=>accounts.confirmAge(source.id),()=>accounts.acceptTerms(source.id)];
   attempts=mutations.map(mutate=>mutate().then(value=>({value}),error=>({error})));
   // Observe every independent transaction blocked behind adoption before commit.
   const deadline=Date.now()+3000;let waiting=0;
   while(Date.now()<deadline){
    await tx`SELECT pg_stat_clear_snapshot()`;
    const [activity]=await tx`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT user_id FROM public.users WHERE user_id=$1 FOR %'`;
    waiting=Number(activity!.n);if(waiting>=mutations.length)break;
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal(waiting,mutations.length,'all stale requests must reach the held account lock');
  });
  for(const attempt of await Promise.all(attempts))assert.equal((attempt.error as {code?:string})?.code,'account_not_found');
  assert.equal(await accounts.resolveIdentity(source.authId),target!.user_id);
  assert.equal(Number((await db`SELECT count(*) AS n FROM public.chat_state WHERE user_id=${source.id}`)[0]!.n),0);
  assert.notEqual((await accounts.getMe(source.id)).display_name,'Must not be orphaned');
 });
 await t.test('verified Telegram bootstrap selects existing bot account before creating a user and tolerates concurrent login',async()=>{
  const telegramId=String(Math.floor(Math.random()*1_000_000_000)+5_000_000_000),authId=randomUUID();
  const [target]=await db`INSERT INTO public.users(display_name,language,language_confirmed_at,age_confirmed_at,terms_accepted_at,subscription_sku,subscription_until)
   VALUES('Existing neutral bot user','ru',now(),now(),now(),'test_base',now()+interval '10 days') RETURNING user_id,subscription_until::text`;
  await db`INSERT INTO public.user_identities(user_id,provider,external_id) VALUES(${target!.user_id},'telegram',${telegramId})`;
  const input={auth_user_id:authId,is_anonymous:false,display_name:'Must not replace explicit name',locale:'en',verified_telegram_id:telegramId};
  const results=await Promise.all([accounts.bootstrap(input),accounts.bootstrap(input)]);
  for(const result of results){assert.equal(result.user_id,target!.user_id);assert.equal(result.language,'ru');assert.equal(result.display_name,'Existing neutral bot user');assert.equal(result.subscription_sku,'test_base');assert.ok(result.age_confirmed_at&&result.terms_accepted_at);}
  assert.equal(Number((await db`SELECT count(*) AS n FROM public.user_identities WHERE provider='supabase' AND external_id=${authId}`)[0]!.n),1);
 });
 await t.test('two nonempty accounts keep Web scene, close legacy Telegram scene and route future Telegram access to Web rights',async()=>{
  const web=await owner(),telegramId=String(Math.floor(Math.random()*1_000_000_000)+7_000_000_000),legacyScene='legacy-'+randomUUID(),webScene='web-'+randomUUID();
  const {chat:webChat}=await accounts.createChat(web.id,1,'roleplay',randomUUID());
  const [webState]=await db`SELECT chat_id FROM public.chat_state WHERE chat_code=${webChat.chat_code}`;
  const webId=Number(webState!.chat_id);
  await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${webId},${webScene},'roleplay',1)`;
  await db`UPDATE public.chat_state SET active_scene_session_id=${webScene},current_turn_no=0,scene_turn_no=0 WHERE chat_id=${webId}`;
  const [legacy]=await db`INSERT INTO public.users(display_name,language,language_confirmed_at,age_confirmed_at,terms_accepted_at,subscription_sku,subscription_until)
   VALUES('Neutral legacy account','ru',now(),now(),now(),'test_base',now()+interval '12 days') RETURNING user_id,subscription_until::text`;
  await db`INSERT INTO public.user_identities(user_id,provider,external_id) VALUES(${legacy!.user_id},'telegram',${telegramId})`;
  await db`INSERT INTO public.chat_state(chat_id,source,source_user_id,user_id,character_i,selected_character_i,active_scene_session_id)
   VALUES(${telegramId},'telegram',${telegramId},${legacy!.user_id},1,1,${legacyScene})`;
  await db`INSERT INTO public.chat_scene_sessions(chat_id,scene_session_id,scene_mode,character_i) VALUES(${telegramId},${legacyScene},'fast',1)`;
  await db`INSERT INTO public.chat_messages(chat_id,sender_type,event_type,message_text,source,turn_no,seq_in_turn) VALUES(${telegramId},'assistant','scene.start.greeting','Legacy neutral history','telegram',1,1)`;
  const hash=linkHash(randomUUID()),proof=linkHash(randomUUID());await features.issueTelegramChallenge(web.id,web.authId,hash);
  assert.deepEqual(await features.completeTelegramLink(web.id,web.authId,hash,telegramId,proof),{linked:true,user_id:web.id});
  const [closed]=await db`SELECT user_id,is_active,active_scene_session_id,telegram_account_user_id FROM public.chat_state WHERE chat_id=${telegramId}`;
  assert.equal(closed!.user_id,legacy!.user_id);assert.equal(closed!.is_active,false);assert.equal(closed!.active_scene_session_id,null);assert.equal(closed!.telegram_account_user_id,web.id);
  assert.equal((await accounts.getChat(web.id,webChat.chat_code)).scene_session_id,webScene);
  assert.ok(!(await accounts.history(web.id,webChat.chat_code)).messages.some(message=>message.text==='Legacy neutral history'));
  assert.equal((await accounts.getMe(web.id)).subscription_sku,'test_base');assert.equal((await accounts.getMe(legacy!.user_id)).subscription_until,null);
  const {ChatAccessRepository}=await import('../src/application/chatAccessRepository.js');const telegram=new ChatAccessRepository(db);
  const menu=await telegram.ensureAndLoadAccessContext(Number(telegramId),'telegram',Number(telegramId),'UTC');
  assert.equal(menu.user_id,web.id);assert.equal(menu.subscription_active,true);assert.equal(menu.character_i,null);assert.equal(menu.active_scene_exists,false);
  const dialogue=await telegram.ensureAndLoadAccessContext(Number(telegramId),'telegram',Number(telegramId),'UTC',1,true);
  assert.equal(dialogue.chat_id,webId);assert.equal(dialogue.telegram_chat_id,Number(telegramId));assert.equal(dialogue.active_scene_session_id,webScene);assert.equal(dialogue.user_id,web.id);
  assert.deepEqual(await features.completeTelegramLink(web.id,web.authId,hash,telegramId,proof),{linked:true,user_id:web.id});
 });
});
