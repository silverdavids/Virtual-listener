const test = require('node:test');
const assert = require('node:assert/strict');
const {createLeagueMonitor} = require('./league-monitor');
const {parseFeedEventsBoards, buildFeedEventsQueuePayload} = require('./auto-sync');
const {createLiveStateMonitor} = require('./provider-live-state');
const fixture = require('./test-fixtures/provider-progress.json');
const start = Date.parse('2026-09-13T07:53:37.000Z');
function feed(at, league = '78') {
  const raw = structuredClone(fixture.events[0]);
  raw.c = 'ANNOUNCEMENT'; raw.d = start; raw.e = start;
  raw.f.b.a = {a:{d:league}}; raw.f.b.c.b = 'ACCEPTING_TICKETS';
  for (const row of Object.values(raw.f.b.c.c)) {
    row.b.c = 'ACCEPTING_TICKETS'; row.b.f = start; row.b.h = {};
  }
  return {header:{serverTime:at},events:[raw]};
}
test('unchanged accepting boards heartbeat across freshness intervals without reimporting odds', async () => {
  const queues = [], livePosts = [], boards = [];
  let now = start - 180000;
  const monitor = createLeagueMonitor({parseBoards:parseFeedEventsBoards,buildQueue:buildFeedEventsQueuePayload,
    postQueue:async p => queues.push(p),postBoard:async p => {boards.push(p);return {posted:true};},log:()=>{}});
  const live = createLiveStateMonitor({post:async p=>livePosts.push(p),now:()=>now,log:()=>{}});
  for (let elapsed=0;elapsed<=120000;elapsed+=5000) {
    now = start - 180000 + elapsed;
    for (const league of ['21','78']) {
      const json = feed(now,league);
      await monitor.ingest(json,league,now);
      live.observe(json,league);
    }
    await live.flush();
    for (const league of ['21','78']) {
      const latest = queues.filter(p=>p.leagueId===league).at(-1);
      assert.ok(now-Date.parse(latest.lastSeenAtUtc)<15000);
      assert.equal(latest.boards[0].availabilityStatus,'ACCEPTING_TICKETS');
      assert.equal(latest.boards[0].providerStatus,'ANNOUNCEMENT');
      const state = livePosts.filter(p=>p.leagueId===league).at(-1);
      assert.ok(now-Date.parse(state.sourceUpdatedAtUtc)<15000);
      assert.equal(state.state,'UPCOMING');assert.equal(state.suspended,false);
    }
  }
  assert.equal(boards.length,2);
  for (const league of ['21','78']) {
    const posts = queues.filter(p=>p.leagueId===league);
    assert.equal(posts.length,9);
    assert.deepEqual(posts[0].boards,posts.at(-1).boards);
  }
  const source = livePosts.at(-1).sourceUpdatedAtUtc;
  now+=45000;await live.flush();
  assert.equal(livePosts.at(-1).sourceUpdatedAtUtc,source,'disconnected timer must not invent a fresh provider observation');
});
test('failed heartbeat retries and older responses cannot replace latest observation', async () => {
  let attempts=0;
  const posts=[];
  const monitor=createLeagueMonitor({parseBoards:parseFeedEventsBoards,buildQueue:buildFeedEventsQueuePayload,
    postBoard:async()=>({posted:true}),postQueue:async p=>{if (++attempts===2) throw Error('offline');posts.push(p);},log:()=>{}});
  const now=start-180000;
  await monitor.ingest(feed(now),'78',now);
  await monitor.ingest(feed(now+15000),'78',now+15000);
  await monitor.ingest(feed(now+20000),'78',now+20000);
  await monitor.ingest(feed(now+10000),'78',now+10000);
  assert.equal(attempts,3);assert.equal(posts.at(-1).lastSeenAtUtc,new Date(now+20000).toISOString());
});
