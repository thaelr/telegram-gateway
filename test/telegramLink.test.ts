import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { TelegramLoginVerifier } from '../src/web/telegramLink.js';

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
const time=1_793_664_000_000;
const nonce='a'.repeat(43);
const defaults={iss:'https://oauth.telegram.org',aud:'12345',sub:'opaque-subject',iat:time/1000-1,exp:time/1000+300,nonce,id:987654321};
function jwt(claims:Record<string,unknown>={},header:Record<string,unknown>={}) {
  const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key',typ:'JWT',...header})).toString('base64url');
  const body=Buffer.from(JSON.stringify({...defaults,...claims})).toString('base64url');
  return `${head}.${body}.${sign('RSA-SHA256',Buffer.from(`${head}.${body}`),privateKey).toString('base64url')}`;
}
function verifier() {
  let calls=0;
  const fetcher:typeof fetch=async (url,init)=>{
    calls++;assert.equal(url,'https://oauth.telegram.org/.well-known/jwks.json');
    assert.equal(init?.redirect,'error');
    return new Response(JSON.stringify({keys:[jwk]}));
  };
  return {instance:new TelegramLoginVerifier('12345',fetcher,()=>time),calls:()=>calls};
}

test('Telegram proof verifies fixed JWKS RS256 and uses numeric profile id, never opaque subject',async()=>{
  const {instance,calls}=verifier();
  assert.equal(await instance.verify(jwt(),nonce),'987654321');
  assert.equal(await instance.verify(jwt(),nonce),'987654321');
  assert.equal(calls(),1);
});
test('Telegram proof rejects wrong nonce, audience, issuer, timestamp and unsigned profile identity',async()=>{
  const {instance,calls}=verifier();
  for(const changes of [{nonce:'other'},{aud:'other'},{iss:'https://evil.invalid'},{exp:time/1000},
    {iat:time/1000+60},{iat:time/1000-601},{id:undefined},{id:'987654321'},{id:0},{id:4503599627370496},{nbf:time/1000+60}]){
    await assert.rejects(instance.verify(jwt(changes),nonce),{code:'invalid_telegram_proof'});
  }
  assert.equal(calls(),0);
});
test('Telegram proof rejects algorithm substitution, changed payload, untrusted key and malformed data',async()=>{
  const {instance}=verifier();
  await assert.rejects(instance.verify(jwt({}, {alg:'HS256'}),nonce),{code:'invalid_telegram_proof'});
  await assert.rejects(instance.verify(jwt({}, {kid:'unknown',jku:'https://evil.invalid'}),nonce),{code:'invalid_telegram_proof'});
  const parts=jwt().split('.');parts[1]=Buffer.from(JSON.stringify({...defaults,id:1})).toString('base64url');
  await assert.rejects(instance.verify(parts.join('.'),nonce),{code:'invalid_telegram_proof'});
  for(const invalid of ['token','a.b.c','.'.repeat(20)])await assert.rejects(instance.verify(invalid,nonce),{code:'invalid_telegram_proof'});
});
test('Telegram key fetch failure fails closed without logging sensitive proof',async()=>{
  const fetcher:typeof fetch=async()=>{throw new Error('private diagnostic');};
  const instance=new TelegramLoginVerifier('12345',fetcher,()=>time);
  await assert.rejects(instance.verify(jwt(),nonce),{code:'telegram_login_unavailable'});
});

test('concurrent valid proofs share one bounded JWKS fetch',async()=>{
 let calls=0;let release!:()=>void;
 const ready=new Promise<void>(resolve=>{release=resolve;});
 const fetcher:typeof fetch=async()=>{calls++;await ready;return new Response(JSON.stringify({keys:[jwk]}));};
 const instance=new TelegramLoginVerifier('12345',fetcher,()=>time);
 const proofs=Array.from({length:10},()=>instance.verify(jwt(),nonce));
 assert.equal(calls,1);release();
 assert.deepEqual(await Promise.all(proofs),Array(10).fill('987654321'));
});
