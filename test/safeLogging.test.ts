import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { safeLogSerializers, safeErrorCode } from '../src/safeLogging.js';

test('HTTP serializers retain correlation without bearer, chat, payment, URL or error detail', async t => {
  let log='';const stream=new Writable({write(chunk,_encoding,done){log+=chunk.toString();done();}});
  const app=Fastify({logger:{stream,serializers:safeLogSerializers}});t.after(()=>app.close());
  app.post('/test/:id',request=>{
    request.log.error({err:Object.assign(new Error('PRIVATE_CHAT_TEXT'),{detail:'PRIVATE_PAYMENT_PAYLOAD',code:'23505'})},'Request failed');
    return {ok:true};
  });
  await app.inject({method:'POST',url:'/test/PRIVATE_PATH?secret=PRIVATE_QUERY',headers:{authorization:'Bearer PRIVATE_BEARER'},payload:{text:'PRIVATE_BODY'}});
  for(const secret of ['PRIVATE_CHAT_TEXT','PRIVATE_PAYMENT_PAYLOAD','PRIVATE_PATH','PRIVATE_QUERY','PRIVATE_BEARER','PRIVATE_BODY'])assert.ok(!log.includes(secret),secret+' must not be logged');
  assert.ok(log.includes('23505'));assert.ok(log.includes('reqId'));
  assert.equal(safeErrorCode({code:'secret-from-upstream'}),'internal_error');
});
