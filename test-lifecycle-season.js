const test=require('node:test');
const assert=require('node:assert/strict');
const {parseLiveBoard,createLiveStateMonitor,keyOf}=require('./provider-live-state');
const {parseFeedEventsBoards}=require('./auto-sync');
const rawFixture=require('./test-fixtures/provider-progress.json');
const captured=require('./test-fixtures/lifecycle-study.json');
for(const season of ['8007',String(captured.pre.leagueNumber)]) test('season metadata survives parsing and restart: '+season,async()=>{
 const raw=structuredClone(rawFixture.events[0]);raw.f.b.e=season;raw.f.b.c.e='wrong nested season';
 const time=rawFixture.header.serverTime;
 const parsed=parseLiveBoard(raw,time,'78');assert.equal(parsed.leagueId,'78');assert.equal(parsed.leagueNumber,season);
 const boards=parseFeedEventsBoards({header:{serverTime:time},events:[raw]},'78');assert.equal(boards[0].leagueNumber,season);
 const posts=[];const monitor=createLiveStateMonitor({post:async p=>posts.push(p),now:()=>time,log:()=>{}});
 monitor.observe({header:{serverTime:time},events:[raw]},'78');await monitor.flush();assert.equal(posts[0].leagueNumber,season);
 const saved=[...monitor.entries.values()][0].raw;assert.equal(saved.f.b.e,season);
 assert.equal(parseLiveBoard(saved,time,'78').leagueNumber,season);
 assert.notEqual(keyOf(parsed),keyOf({...parsed,leagueId:'21'}));
});
test('elapsed duration and queue removal never fabricate completion; delayed provider final still wins',async()=>{
 const raw=structuredClone(rawFixture.events[0]);const start=raw.f.b.c.c[0].b.h.c;const time=start+300000;
 const posts=[];const monitor=createLiveStateMonitor({post:async p=>posts.push(p),now:()=>time,log:()=>{}});
 monitor.observe({header:{serverTime:time},events:[raw]},'78');await monitor.flush();assert.equal(posts.at(-1).state,'LIVE');assert.equal(posts.at(-1).minute,90);
 monitor.observe({header:{serverTime:time+1},events:[]},'78');await monitor.flush();assert.equal(posts.at(-1).state,'LIVE');
 raw.c='RESULTS';raw.f.b.c.b='DISPLAY_RESULTS';monitor.observe({header:{serverTime:time+9253},event:raw},'78');await monitor.flush();assert.equal(posts.at(-1).state,'FINISHED');
 raw.c='PROGRESS';raw.f.b.c.b='RACING';monitor.observe({header:{serverTime:time+10000},event:raw},'78');await monitor.flush();assert.equal(posts.at(-1).state,'FINISHED');
});

test('legacy detail cache refuses display labels and isolates stable league/event identity',()=>{
 const {getEventDetailCacheKey}=require('./auto-sync');
 assert.equal(getEventDetailCacheKey({leagueNumber:'8008',weekNumber:1,firstMatch:'A vs B'}),null);
 assert.notEqual(getEventDetailCacheKey({leagueId:'78',providerEventId:'same'}),getEventDetailCacheKey({leagueId:'21',providerEventId:'same'}));
 assert.notEqual(getEventDetailCacheKey({leagueId:'78',providerEventId:'first'}),getEventDetailCacheKey({leagueId:'78',providerEventId:'second'}));
});
