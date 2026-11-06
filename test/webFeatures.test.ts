import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerWebFeatures } from '../src/web/features.js';
import { WebAuthError } from '../src/web/auth.js';
import { WebError, type WebProfile, type WebRepositoryContract } from '../src/web/types.js';
import type { WebFeaturesRepositoryContract } from '../src/web/featuresTypes.js';
import { linkHash } from '../src/web/telegramLink.js';

const authId = '11111111-1111-4111-8111-111111111111';
const me = { user_id:'u0000001',language:'en',language_confirmed_at:'2026-01-01',age_confirmed_at:'2026-01-01',terms_accepted_at:'2026-01-01' } as WebProfile;
function setup(overrides: Partial<WebFeaturesRepositoryContract> = {}, profile = me, enabled = true) {
  const calls: unknown[][] = [];
  const features: WebFeaturesRepositoryContract = {
    publications: async (...args) => { calls.push(['publications',...args]); return {posts:[],next_before:null}; },
    voting: async () => ({campaign:null}), castVote: async (...args) => {calls.push(['vote',...args]);},
    summaries: async () => ({chats:[]}), markRead: async (...args) => {calls.push(['read',...args]);return {last_read_message_id:args[2]};},
    telegramStatus: async () => ({linked:false,telegram_user_id:null}),
    issueTelegramChallenge: async (...args) => {calls.push(['issue',...args]);return {expires_at:'2026-11-03T13:00:00Z'};},
    telegramChallenge: async (...args) => {calls.push(['bound',...args]);return {user_id:me.user_id,auth_user_id:authId,expires_at:'2026-11-03T13:00:00Z',consumed_at:null,linked_user_id:null};},
    completeTelegramLink: async (...args) => {calls.push(['complete',...args]);return {linked:true,user_id:me.user_id};},
    ...overrides,
  };
  const app = Fastify({logger:false});
  registerWebFeatures(app, {
    authenticator: {verify: async value => {if(value!=='Bearer owner')throw new WebAuthError(401,'unauthorized');return {auth_user_id:authId,is_anonymous:true,display_name:null,locale:null};}},
    repository: {resolveIdentity:async()=>me.user_id,getMe:async()=>profile} as unknown as WebRepositoryContract,
    features,telegramClientId:enabled?'12345':'',
    telegramVerifier:{verify:async(...args)=>{calls.push(['verify',...args]);return '123456';}},
  });
  return {app,calls};
}
const headers = {authorization:'Bearer owner'};

test('ancillary endpoints authenticate and expose true empty publication/campaign state', async () => {
  const {app,calls}=setup();
  try {
    assert.equal((await app.inject({url:'/web/publications'})).statusCode,401);
    const response=await app.inject({url:'/web/publications',headers});
    assert.deepEqual(response.json(),{posts:[],next_before:null});
    assert.equal(response.headers['cache-control'],'no-store');
    assert.deepEqual(calls[0],['publications',me.user_id,undefined,undefined]);
    assert.deepEqual((await app.inject({url:'/web/voting',headers})).json(),{campaign:null});
    assert.equal((await app.inject({method:'POST',url:'/web/publications',headers,payload:{body:'fake'}})).statusCode,404);
  } finally {await app.close();}
});

test('votes require consent and never accept a client account id', async () => {
  const campaign='11111111-1111-4111-8111-111111111112';
  const candidate='11111111-1111-4111-8111-111111111113';
  const {app,calls}=setup({}, {...me,age_confirmed_at:null});
  try {
    const result=await app.inject({method:'POST',url:`/web/voting/${campaign}/vote`,headers,payload:{candidate_id:candidate}});
    assert.equal(result.statusCode,403); assert.deepEqual(calls,[]);
  } finally {await app.close();}
  const valid=setup();
  try {
    const forged=await valid.app.inject({method:'POST',url:`/web/voting/${campaign}/vote`,headers,payload:{candidate_id:candidate,user_id:'other'}});
    assert.equal(forged.statusCode,400);
    assert.equal((await valid.app.inject({method:'POST',url:`/web/voting/${campaign}/vote`,headers,payload:{candidate_id:candidate}})).statusCode,200);
    assert.deepEqual(valid.calls,[['vote',me.user_id,campaign,candidate]]);
  } finally {await valid.app.close();}
});

test('read markers are scoped to the verified account and reject foreign messages', async () => {
  const {app,calls}=setup({markRead:async (...args)=>{calls.push(['read',...args]);throw new WebError(404,'message_not_found');}});
  try {
    const response=await app.inject({method:'POST',url:'/web/chats/c0000001/read',headers,payload:{message_id:'t:12'}});
    assert.equal(response.statusCode,404);
    assert.deepEqual(calls,[['read',me.user_id,'c0000001','t:12']]);
  } finally {await app.close();}
});

test('Telegram nonce stored only as digest; completion checks binding before signed identity', async () => {
  const {app,calls}=setup();
  try {
    const issued=await app.inject({method:'POST',url:'/web/me/telegram-link',headers,payload:{}});
    const {challenge,client_id}=issued.json();
    assert.equal(client_id,'12345'); assert.match(challenge,/^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(calls[0],['issue',me.user_id,authId,linkHash(challenge)]);
    const completed=await app.inject({method:'POST',url:'/web/me/telegram-link/complete',headers,payload:{challenge,id_token:'signed-proof'}});
    assert.deepEqual(completed.json(),{linked:true,user_id:me.user_id});
    assert.deepEqual(calls.slice(1),[
      ['bound',me.user_id,authId,linkHash(challenge)],['verify','signed-proof',challenge],
      ['complete',me.user_id,authId,linkHash(challenge),'123456',linkHash('signed-proof')],
    ]);
  } finally {await app.close();}
});

test('Telegram configuration absent or foreign challenge cannot mutate accounts', async () => {
  const disabled=setup({},me,false);
  try {
    assert.deepEqual((await disabled.app.inject({url:'/web/me/telegram-link',headers})).json(),{linked:false,telegram_user_id:null,available:false});
    assert.equal((await disabled.app.inject({method:'POST',url:'/web/me/telegram-link',headers,payload:{}})).statusCode,503);
    assert.deepEqual(disabled.calls,[]);
  } finally {await disabled.app.close();}
  const foreign=setup({telegramChallenge:async()=>{throw new WebError(410,'telegram_link_expired');}});
  try {
    assert.equal((await foreign.app.inject({method:'POST',url:'/web/me/telegram-link/complete',headers,payload:{challenge:'a'.repeat(43),id_token:'signed-proof'}})).statusCode,410);
    assert.deepEqual(foreign.calls,[]);
  } finally {await foreign.app.close();}
});
