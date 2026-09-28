const test=require('node:test'),assert=require('node:assert/strict');
const {parseLiveBoard}=require('./provider-live-state');
const captured=require('./test-fixtures/champions-clock.json');
const upcoming=()=>{const b=structuredClone(captured.events[0]);b.c='ANNOUNCEMENT';b.f.b.c.b='ACCEPTING_TICKETS';for(const r of b.f.b.c.c){r.b.h={};delete r.b.i.a.d;delete r.b.i.a.g;}return b;};
test('captured Champions upcoming never becomes provider LIVE from a 2h05 wall jump',()=>{
 const b=upcoming();const p=parseLiveBoard(b,b.d+125*60000,'21');
 assert.equal(p.state,'UPCOMING');assert.equal(p.bettingOpen,false);
 assert.equal(p.providerEventId,'788008201');assert.equal(p.leagueNumber,'9722');
});
const {createObservationClock}=require('./provider-clock');
const {createLiveStateMonitor}=require('./provider-live-state');
for(const [name,jump,warning] of [['normal',1000,false],['2h05 forward',125*60000,true],['backward',-60000,true],['small NTP',1200,false]]){
 test(`clock ${name} compares monotonic elapsed and reports discontinuity`,()=>{
  let wall=100000,mono=0;const logs=[],refresh=[];
  const clock=createObservationClock({wall:()=>wall,monotonic:()=>mono,log:s=>logs.push(s),onDiscontinuity:()=>refresh.push(true)});
  wall+=jump;mono+=1000;const value=clock.sample();
  assert.equal(value.discontinuity,warning);assert.equal(logs.length,warning?1:0);assert.equal(refresh.length,logs.length);
  assert.equal(value.utc,100000+(warning?1000:jump));
 });
}
test('clock threshold bounds reject invalid overrides',()=>{
 for(const thresholdMs of [-1,0,999,60001,'bad'])assert.equal(createObservationClock({thresholdMs}).thresholdMs,5000);
 assert.equal(createObservationClock({thresholdMs:1500}).thresholdMs,1500);
});
test('forward/backward jumps preserve per-event observation ordering and request scheduler reconciliation',async()=>{
 const b=upcoming();let wall=b.d-180000,mono=0;const posts=[],logs=[];
 const monitor=createLiveStateMonitor({now:()=>wall,monotonic:()=>mono,post:async p=>posts.push(p),log:s=>logs.push(s),reconciliationMs:1});
 monitor.observe({header:{serverTime:wall},events:[b]},'21');await monitor.flush();
 for(const jump of [125*60000,-125*60000]){wall+=jump;mono+=1000;await monitor.flush();}
 assert.equal(posts.length,3);assert.ok(posts.every(p=>p.state==='UPCOMING'));
 assert.equal(Date.parse(posts[2].observedAtUtc)-Date.parse(posts[0].observedAtUtc),2000);
 assert.ok(posts.every(p=>p.sourceUpdatedAtUtc===posts[0].sourceUpdatedAtUtc));
 assert.equal(logs.filter(s=>s.startsWith('CLOCK-DISCONTINUITY')).length,2);
});
test('genuine LIVE score and minute changes remain accepted across wall discontinuity',async()=>{
 const fixture=structuredClone(require('./test-fixtures/provider-progress.json'));
 let wall=fixture.header.serverTime,mono=0;const posts=[];
 const m=createLiveStateMonitor({now:()=>wall,monotonic:()=>mono,post:async p=>posts.push(p),log:()=>{}});
 m.observe(fixture,'78');await m.flush();wall+=125*60000;mono+=50000;await m.flush();
 assert.equal(posts.at(-1).state,'LIVE');assert.ok(posts.at(-1).minute>=posts[0].minute);
 assert.ok(posts.at(-1).matches.some(r=>r.homeScore>0||r.awayScore>0));
});
test('event identity, kickoff and Champions/EPL clocks are independent',async()=>{
 const b=upcoming();let wall=b.d-1000,mono=0;const posts=[];
 const m=createLiveStateMonitor({now:()=>wall,monotonic:()=>mono,post:async p=>posts.push(p),log:()=>{}});
 m.observe({header:{serverTime:wall},events:[b]},'21');
 const e=structuredClone(b);e.f.b.a={a:'English League',d:78};e.f.b.e=8008;e.d+=60000;
 m.observe({header:{serverTime:wall},events:[e]},'78');await m.flush();
 wall+=1000;mono+=1000;await m.flush();
 const c=posts.filter(p=>p.leagueId==='21').at(-1),epl=posts.filter(p=>p.leagueId==='78').at(-1);
 assert.equal(c.state,'UPCOMING');assert.equal(c.bettingOpen,false);assert.equal(epl.bettingOpen,true);
 const changed=structuredClone(b);changed.d+=1;m.observe({header:{serverTime:wall+1},events:[changed]},'21');
 assert.equal(m.entries.get('["21","788008201"]').raw.d,b.d);
});
test('poisoned unscored legacy LIVE recovers only from a fresh identical upcoming event',()=>{
 const b=upcoming(),now=b.d-1000;const m=createLiveStateMonitor({now:()=>now,post:async()=>{},log:()=>{}});
 m.observe({header:{serverTime:now-1},events:[b]},'21');const key='["21","788008201"]';m.entries.get(key).state='LIVE';
 m.observe({header:{serverTime:now},events:[b]},'21');assert.equal(m.entries.get(key).state,'UPCOMING');
 m.entries.get(key).state='FINISHED';m.observe({header:{serverTime:now+1},events:[b]},'21');assert.equal(m.entries.get(key).state,'FINISHED');
});
test('discontinuity requests a safe feed/results refresh without bypassing in-flight limits',async()=>{
 const {createLeagueRefreshScheduler}=require('./league-monitor');let now=100000,mono=0,calls=0;
 const scheduler=createLeagueRefreshScheduler({now:()=>now,isReady:()=>true,refreshLeague:async()=>{calls++;},pollResults:async()=>{calls++;}});
 await scheduler.tick();assert.equal(calls,4);
 const clock=createObservationClock({wall:()=>now,monotonic:()=>mono,log:()=>{}});now-=60000;mono+=100;
 clock.sample();await scheduler.tick();assert.equal(calls,8);
});
test('invalid timestamps and older provider source cannot replace valid event observations',async()=>{
 const b=upcoming();let now=b.d-1000;const posts=[];
 const m=createLiveStateMonitor({now:()=>now,post:async p=>posts.push(p),log:()=>{}});
 m.observe({header:{serverTime:now},events:[b]},'21');await m.flush();
 for(const value of [NaN,Infinity,1e20,now-1000])m.observe({header:{serverTime:value},events:[b]},'21');
 const entry=m.entries.get('["21","788008201"]');assert.equal(entry.serverTime,now);assert.equal(posts.length,1);
 assert.equal(parseLiveBoard({...b,d:'invalid'},now,'21'),null);
});
