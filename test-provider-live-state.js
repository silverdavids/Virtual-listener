const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseLiveBoard,createLiveStateMonitor,keyOf} = require('./provider-live-state');
const fixture = require('./test-fixtures/provider-progress.json');
const raw = () => structuredClone(fixture.events[0]);
const start = fixture.events[0].f.b.c.c[0].b.h.c;

test('provider scene policy survives persisted lifecycle snapshots',async t=>{
  const h=persistenceHarness(t),monitor=h.make(),payload=structuredClone(fixture);
  payload.events[0].f.b.d='SCENE_6';
  monitor.observe(payload,'78');await monitor.flush();
  assert.equal([...h.make().entries.values()][0].raw.f.b.d,'SCENE_6');
});

function persistenceHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-persistence-'));
  const file = path.join(dir, 'state.json');
  const logs = [], posts = [];
  t.after(() => {
    // Only files in this newly created, private test directory are removed.
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const make = () => createLiveStateMonitor({file, now:()=>start+50000,
    post:async p=>posts.push(p), log:line=>logs.push(line), ...options});
  return {dir,file,logs,posts,make};
}
function validLedger() {
  const monitor = createLiveStateMonitor({post:async()=>{},now:()=>start+50000,log:()=>{}});
  monitor.observe(fixture,'78');
  return [...monitor.entries];
}

for (const [name, content] of [['missing', undefined], ['valid empty', '[]'], ['valid populated', JSON.stringify(validLedger())]]) {
  test(`persistence startup: ${name}`, async t => {
    const h = persistenceHarness(t);
    if (content !== undefined) fs.writeFileSync(h.file,content);
    const monitor = h.make();
    assert.equal(monitor.entries.size, name === 'valid populated' ? 1 : 0);
    await monitor.flush();
    assert.deepEqual(h.logs.filter(line=>line.includes('WARNING')),[]);
    assert.equal(h.make().entries.size, monitor.entries.size);
  });
}

const badLedger = mutation => {const data=validLedger();mutation(data);return JSON.stringify(data);};
for (const [name, content] of [
  ['empty',''], ['whitespace',' \r\n\t '], ['malformed','{private-state'], ['object','{}'], ['null','null'],
  ['tuple','[[]]'], ['tuple extra field','[["key",{},0]]'], ['key','[["not-json",{}]]'],
  ['key wrong league',badLedger(data=>data[0][0]='["99","event"]')],
  ['key wrong event',badLedger(data=>data[0][0]='["78","other"]')],
  ['null value',badLedger(data=>data[0][1]=null)], ['array value',badLedger(data=>data[0][1]=[])],
  ['string value',badLedger(data=>data[0][1]='private-state')],
  ['missing raw',badLedger(data=>delete data[0][1].raw)],
  ['invalid time',badLedger(data=>data[0][1].receivedAt='invalid')],
  ['invalid state',badLedger(data=>data[0][1].state='unknown')],
  ['duplicate key',badLedger(data=>data.push(data[0]))],
  ['valid then invalid entry',badLedger(data=>data.push(['bad',{}]))],
]) {
  test(`persistence quarantines ${name} and restarts safely`, async t => {
    const h=persistenceHarness(t);fs.writeFileSync(h.file,content);
    const monitor=h.make();assert.equal(monitor.entries.size,0);
    const backups=fs.readdirSync(h.dir);assert.equal(backups.length,1);
    assert.match(backups[0],/^state\.json\.corrupt-.*\.bak$/);
    assert.equal(fs.readFileSync(path.join(h.dir,backups[0]),'utf8'),content);
    assert.equal(fs.existsSync(h.file),false);
    assert.ok(h.logs[0].includes(h.file));assert.ok(h.logs[0].includes(path.join(h.dir,backups[0])));
    assert.equal(h.logs.join('').includes('private-state'),false);
    await monitor.flush();
    monitor.observe(fixture,'78');await monitor.flush();
    assert.equal(h.make().entries.size,1);
    assert.equal(fs.readFileSync(path.join(h.dir,backups[0]),'utf8'),content);
  });
}

test('quarantine failure leaves primary untouched and starts safely in memory',async t=>{
  const io={...fs,renameSync:()=>{throw new Error('private-state');}};
  const h=persistenceHarness(t,{io});fs.writeFileSync(h.file,'bad');
  const monitor=h.make();assert.equal(monitor.entries.size,0);
  await monitor.flush();monitor.observe(fixture,'78');await monitor.flush();
  assert.equal(fs.readFileSync(h.file,'utf8'),'bad');
  assert.match(h.logs[0],/quarantine failed.*original=.*backup=/);
  assert.equal(h.logs.join('').includes('private-state'),false);
  assert.equal(h.posts.length,1);
});

test('atomic replacement flushes and closes before rename and preserves unknown temporary files',t=>{
  const steps=[];const io={...fs};
  for(const method of ['openSync','writeFileSync','fsyncSync','closeSync','renameSync']) {
    io[method]=(...args)=>{steps.push(method);return fs[method](...args);};
  }
  const h=persistenceHarness(t,{io});fs.writeFileSync(h.file,'[]');fs.writeFileSync(h.file+'.tmp','recoverable');
  const monitor=h.make();monitor.observe(fixture,'78');
  assert.deepEqual(steps,['openSync','writeFileSync','fsyncSync','closeSync','renameSync']);
  assert.equal(h.make().entries.size,1);assert.equal(fs.readFileSync(h.file+'.tmp','utf8'),'recoverable');
  assert.equal(fs.readdirSync(h.dir).length,2);
});

test('serialization failure never opens output or changes the valid primary',async t=>{
  const h=persistenceHarness(t);fs.writeFileSync(h.file,'[]');const monitor=h.make();
  const entry=validLedger()[0];entry[1].circular=entry[1];monitor.entries.set(...entry);
  await assert.rejects(monitor.flush(),/circular/i);
  assert.equal(fs.readFileSync(h.file,'utf8'),'[]');assert.deepEqual(fs.readdirSync(h.dir),['state.json']);
});

for(const method of ['openSync','writeFileSync','fsyncSync','closeSync','renameSync']) {
  test(`atomic ${method} failure preserves primary and cleans only its own temporary file`,t=>{
    const io={...fs};let failed=false;
    io[method]=(...args)=>{if(!failed){failed=true;throw Object.assign(new Error('injected'),{code:'EACCES'});}return fs[method](...args);};
    const h=persistenceHarness(t,{io});const original=JSON.stringify(validLedger());
    fs.writeFileSync(h.file,original);fs.writeFileSync(h.file+'.unknown.tmp','recoverable');
    const monitor=h.make();assert.throws(()=>monitor.observe(fixture,'78'),/injected/);
    assert.equal(fs.readFileSync(h.file,'utf8'),original);
    assert.deepEqual(fs.readdirSync(h.dir).sort(),['state.json','state.json.unknown.tmp']);
    monitor.observe(fixture,'78');assert.equal(h.make().entries.size,1);
  });
}

test('rapid observations and overlapping flush calls produce a complete restartable ledger',async t=>{
  let release;const h=persistenceHarness(t,{post:()=>new Promise(resolve=>{release=resolve;})});
  const monitor=h.make();monitor.observe(fixture,'78');const flushing=monitor.flush();
  for(let i=1;i<=30;i++) monitor.observe({...fixture,header:{serverTime:fixture.header.serverTime+i}},'78');
  await monitor.flush();release();await flushing;
  assert.equal(h.make().entries.values().next().value.serverTime,fixture.header.serverTime+30);
  assert.deepEqual(fs.readdirSync(h.dir),['state.json']);
});

test('partial temporary write failure preserves the primary and removes its partial output',t=>{
  const io={...fs,writeFileSync:(fd)=>{fs.writeSync(fd,'partial');throw Error('injected write failure');}};
  const h=persistenceHarness(t,{io});fs.writeFileSync(h.file,'[]');
  assert.throws(()=>h.make().observe(fixture,'78'),/injected write failure/);
  assert.equal(fs.readFileSync(h.file,'utf8'),'[]');assert.deepEqual(fs.readdirSync(h.dir),['state.json']);
});

test('authoritative removal rejects an older reappearance and completed events stop periodic posting',async()=>{
  let now=start+1000;const posts=[];
  const monitor=createLiveStateMonitor({post:async p=>posts.push(p),now:()=>now,log:()=>{}});
  monitor.observe({header:{serverTime:now},events:[raw()]},'78');await monitor.flush();
  now+=1000;monitor.observe({header:{serverTime:now},events:[]},'78');await monitor.flush();
  assert.equal(posts.at(-1).available,false);
  monitor.observe({header:{serverTime:now-500},events:[raw()]},'78');
  now+=20000;await monitor.flush();assert.equal(posts.at(-1).available,false);
  const finished=raw();finished.c='RESULTS';finished.f.b.c.c.forEach(r=>r.b.i.a.d={a:1,b:0});
  monitor.observe({header:{serverTime:now},events:[finished]},'78');await monitor.flush();
  const count=posts.length;assert.equal(posts.at(-1).state,'FINISHED');
  now+=20000;await monitor.flush();assert.equal(posts.length,count);
});

test('verified PROGRESS/RACING fields decode UTC IDs, minute and independent changing scores without future leakage',()=>{
  const before=parseLiveBoard(raw(),start,'78');
  assert.equal(before.state,'LIVE');assert.equal(before.minute,0);
  assert.equal(before.matches.length,10);assert.ok(before.matches.every(m=>m.homeScore===0&&m.awayScore===0));
  const later=parseLiveBoard(raw(),start+50000,'78');
  assert.ok(later.minute>0);
  assert.ok(later.matches.some(m=>m.homeScore>0||m.awayScore>0));
  assert.ok(later.matches.some(m=>m.homeScore===0&&m.awayScore===0));
  assert.equal(new Set(later.matches.map(m=>m.providerMatchId)).size,10);
});
test('exact planned UTC start closes delayed announcement without expiring its display',()=>{
  const b=raw(); b.c='ANNOUNCEMENT'; b.f.b.c.b='ACCEPTING_TICKETS';
  b.f.b.c.c.forEach(r=>{r.b.h={}; r.b.i.a.g={a:[]};});
  assert.equal(parseLiveBoard(b,b.d-1,'78').state,'UPCOMING');
  assert.equal(parseLiveBoard(b,b.d,'78').state,'UPCOMING');
  assert.equal(parseLiveBoard(b,b.d,'78').bettingOpen,false);
  assert.equal(parseLiveBoard(b,b.d+1,'78').matches.length,10);
});
test('finished phase uses final scores and never treats future fragment outcomes as current',()=>{
  const b=raw();b.c='RESULTS';
  b.f.b.c.c.forEach((r,i)=>{r.b.i.a.d={a:i,b:0};});
  const p=parseLiveBoard(b,start+100000,'78');
  assert.equal(p.state,'FINISHED');assert.equal(p.minute,90);
  assert.equal(p.matches[3].homeScore,3);assert.equal(parseLiveBoard(b,start,'21'),null);
});
test('stale feeds cannot replace live timelines; changes deduplicate and periodic reconciliation still posts',async()=>{
  let now=start+1000;const posts=[];
  const monitor=createLiveStateMonitor({post:async p=>posts.push(p),now:()=>now,log:()=>{}});
  monitor.observe({...fixture,header:{serverTime:now}},'78');await monitor.flush();await monitor.flush();
  assert.equal(posts.length,1);
  const b=raw();b.c='ANNOUNCEMENT';b.f.b.c.b='ACCEPTING_TICKETS';
  monitor.observe({header:{serverTime:now-10},events:[b]},'78');
  now+=50000;await monitor.flush();assert.equal(posts.at(-1).state,'LIVE');
  assert.ok(posts.at(-1).matches.some(m=>m.homeScore>0||m.awayScore>0));
  now+=500000;await monitor.flush();const n=posts.length;
  now+=16000;await monitor.flush();assert.equal(posts.length,n+1);
});
test('restart restores league-qualified live identities and never accepts a newer prematch regression',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vh-live-')),file=path.join(dir,'state.json');
  let now=start+50000;const posts=[];
  const make=()=>createLiveStateMonitor({file,now:()=>now,post:async p=>posts.push(p),log:()=>{}});
  const a=make();a.observe({...fixture,header:{serverTime:now}},'78');await a.flush();
  const b=raw();b.f.b.a={a:'Champs League',d:21};
  a.observe({header:{serverTime:now},events:[b]},'21');await a.flush();
  const recovered=make();assert.equal(recovered.entries.size,2);
  b.c='ANNOUNCEMENT';recovered.observe({header:{serverTime:now+100},events:[b]},'21');
  now+=1000;await recovered.flush();
  assert.equal(recovered.entries.get(keyOf({leagueId:'21',providerEventId:b.a})).state,'LIVE');
  assert.ok(posts.some(p=>p.leagueId==='21'));assert.ok(posts.some(p=>p.leagueId==='78'));
  // Leave no persistent test credentials or application state.
  fs.unlinkSync(file);fs.rmdirSync(dir);
});
