const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createProviderFeedClient} = require('./provider-feed-client');
const url='https://globalbet.virtual-horizon.com/engine/shop/feed/events?leagueId=78';
function setup(options) {
  const page=new EventEmitter();const frame={};page.mainFrame=()=>frame;
  const calls=[];page.evaluate=async(fn,args)=>{calls.push(args);return {status:200,body:'{"events":[]}'};};
  const client=createProviderFeedClient(page,{timeoutMs:0,...options});
  const authorize=(address=url,status=200)=>page.emit('response',{url:()=>address,status:()=>status,
    request:()=>({headers:()=>({authorization:'test-only-credential'})})});
  return {page,client,calls,authorize,frame};
}
test('diagnostics reuse only a successful native provider feed authorization',async()=>{
  const h=setup();h.authorize('https://other.invalid/engine/shop/feed/events');
  h.authorize(url,401);await assert.rejects(h.client.fetch(url),/No authenticated/);
  h.authorize();assert.deepEqual(await h.client.fetch(url),{status:200,json:{events:[]}});
  assert.equal(h.calls[0].authorization,'test-only-credential');
  await assert.rejects(h.client.fetch('https://other.invalid/engine/shop/feed/events'),/Provider feed URL/);
  h.client.dispose();assert.equal(h.page.listenerCount('response'),0);
  await assert.rejects(h.client.fetch(url),/No authenticated/);
});
test('navigation and authentication failures invalidate diagnostic credentials',async()=>{
  const h=setup();h.authorize();h.page.emit('framenavigated',h.frame);
  await assert.rejects(h.client.fetch(url),/No authenticated/);h.authorize();
  h.page.evaluate=async()=>({status:403,body:'private-response'});
  await assert.rejects(h.client.fetch(url),/^Error: Provider feed HTTP 403$/);
  await assert.rejects(h.client.fetch(url),/No authenticated/);h.client.dispose();
});
test('diagnostic errors do not expose response bodies or evaluation details',async()=>{
  const h=setup();h.authorize();h.page.evaluate=async()=>({status:200,body:'private-response'});
  await assert.rejects(h.client.fetch(url),/^Error: Provider feed returned invalid JSON \(HTTP 200\)$/);
  h.page.evaluate=async()=>{throw Error('private-credential');};
  await assert.rejects(h.client.fetch(url),/^Error: Provider feed request failed; check login and provider connectivity$/);
  h.client.dispose();
});
test('browser fetch is bounded, same-origin, credentialed and refuses redirects',async t=>{
  const h=setup();h.authorize();
  const previous=Object.getOwnPropertyDescriptor(global,'location');
  Object.defineProperty(global,'location',{configurable:true,writable:true,value:{origin:'https://globalbet.virtual-horizon.com'}});
  t.after(()=>{if(previous)Object.defineProperty(global,'location',previous);else delete global.location;});
  const requests=[];t.mock.method(global,'fetch',async(address,options)=>{
    requests.push({address,options});return {status:200,text:async()=>'{"events":[]}'};
  });
  h.page.evaluate=(fn,args)=>fn(args);
  await h.client.fetch(url);assert.equal(requests.length,1);
  assert.equal(requests[0].options.credentials,'include');assert.equal(requests[0].options.redirect,'error');
  assert.equal(requests[0].options.headers.authorization,'test-only-credential');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  global.location.origin='https://other.invalid';await assert.rejects(h.client.fetch(url),/request failed/);
  assert.equal(requests.length,1);h.client.dispose();
});
