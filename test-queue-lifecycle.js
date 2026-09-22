const test = require('node:test');
const assert = require('node:assert/strict');
const { createLeagueMonitor } = require('./league-monitor');
const { parseFeedEventsBoards, buildFeedEventsQueuePayload, postFeedEventsQueue,
  hasCompleteBoardResults, registerResultLedgerEventBoard, recordResultLedgerObservation } = require('./auto-sync');

const start = Date.parse('2026-09-11T10:22:07Z');
function feed(leagueId = '78', weeks = [37, 38, 1, 2]) {
  return { events: weeks.map((week, index) => ({
    a: `event-${index}`, d: start + index * 330000, e: start + index * 330000,
    f: { b: { a: { a: { d: leagueId, a: leagueId === '78' ? 'English League' : 'Champs League' } },
      c: { a: week, c: Array.from({ length: 10 }, (_, i) => ({ b: {
        a: `match-${index}-${i}`, i: { a: { b: { a: { a: `Home ${i}` }, b: { a: `Away ${i}` } } } },
      } })) } } },
  })) };
}
function harness(options = {}) {
  const queues = [];
  const monitor = createLeagueMonitor({ parseBoards: parseFeedEventsBoards,
    buildQueue: buildFeedEventsQueuePayload, postQueue: async q => queues.push(q),
    postBoard: async () => ({ posted: true }), log: () => {}, ...options });
  return { monitor, queues };
}
const weeks = q => q.boards.map(b => Number(b.weekNumber));

test('equal d/e and expired countdown retain current ID after start, across week wrap', async () => {
  const { monitor, queues } = harness();
  const json = feed();
  json.events[0].countdownSeconds = 0;
  await monitor.ingest(json, '78', start - 1);
  await monitor.ingest(json, '78', start + 1000);
  assert.equal(monitor.states.get('78').current.providerEventId, 'event-0');
  assert.deepEqual(weeks(queues.at(-1)), [37, 38, 1, 2]);
  assert.equal(queues.length, 1, 'unchanged queue is deduplicated');
  assert.ok(queues[0].boards.every(b => b.matches.length === 10));
});

test('completed results roll 37 to 38 without collapsing wrapped weeks or reviving completed IDs', async () => {
  const completed = new Set();
  const { monitor, queues } = harness({ isComplete: b => completed.has(`${b.leagueId}:${b.providerEventId}`) });
  await monitor.ingest(feed(), '78', start + 1);
  completed.add('78:event-0');
  await monitor.ingest(feed(), '78', start + 2);
  assert.deepEqual(weeks(queues.at(-1)), [38, 1, 2]);
  completed.clear();
  await monitor.ingest(feed(), '78', start + 3);
  assert.equal(monitor.states.get('78').current.providerEventId, 'event-1');
  assert.deepEqual(weeks(queues.at(-1)), [38, 1, 2]);
});

test('explicit finish time expires only after a valid positive lifetime; generic e is insufficient', async () => {
  for (const finish of [start, start - 1, 'invalid', undefined, start + 500]) {
    const { monitor, queues } = harness();
    const json = feed();
    json.events[0].e = start + 100;
    json.events[0].finishTime = finish;
    await monitor.ingest(json, '78', start + 200);
    assert.deepEqual(weeks(queues.at(-1)), [37, 38, 1, 2]);
    await monitor.ingest(json, '78', start + 501);
    assert.deepEqual(weeks(queues.at(-1)), finish === start + 500 ? [38, 1, 2] : [37, 38, 1, 2]);
  }
});

test('provider removal promotes next identity and delayed requests cannot restore the old board', async () => {
  const { monitor, queues } = harness();
  await monitor.ingest(feed(), '78', start, () => true, 1);
  const next = feed(); next.events.shift();
  await monitor.ingest(next, '78', start + 1, () => true, 3);
  await monitor.ingest(feed(), '78', start + 1000, () => true, 2);
  assert.deepEqual(weeks(queues.at(-1)), [38, 1, 2]);
  assert.equal(monitor.states.get('78').responseOrder, 3);
});

test('current identity survives reordered provider items; duplicate weeks survive, duplicate IDs do not', async () => {
  const { monitor, queues } = harness();
  const json = feed('78', [37, 38, 1, 1]);
  await monitor.ingest(json, '78', start);
  json.events = [json.events[1], json.events[0], json.events[2], json.events[3], json.events[0]];
  await monitor.ingest(json, '78', start + 1);
  assert.deepEqual(weeks(queues.at(-1)), [37, 38, 1, 1]);
  assert.deepEqual(queues.at(-1).boards.map(b => b.providerEventId), ['event-0','event-1','event-2','event-3']);
});

test('completion, stale requests and re-login generations remain league scoped', async () => {
  let valid = true;
  const { monitor, queues } = harness({ isComplete: b => b.leagueId === '21' && b.providerEventId === 'event-0' });
  await monitor.ingest(feed(), '78', start, () => valid, 10);
  await monitor.ingest(feed('21'), '21', start, () => valid, 1);
  valid = false;
  const next = feed(); next.events.shift();
  await monitor.ingest(next, '78', start + 1, () => valid, 11);
  assert.deepEqual(weeks(queues.find(q => q.leagueId === '78')), [37, 38, 1, 2]);
  assert.deepEqual(weeks(queues.find(q => q.leagueId === '21')), [38, 1, 2]);
  await monitor.ingest(feed(), '78', start + 2, () => true, 12);
  assert.equal(monitor.states.get('78').current.providerEventId, 'event-0');
  const recovered = harness();
  await recovered.monitor.ingest(feed(), '78', start + 2000);
  assert.deepEqual(weeks(recovered.queues[0]), [37, 38, 1, 2], 'fresh browser recovers provider current after start');
});

test('real queue POST serializes all ten fixtures in provider order after current start', async t => {
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  });
  const { monitor } = harness({ postQueue: postFeedEventsQueue });
  for (const league of ['21', '78']) await monitor.ingest(feed(league), league, start + 1000);
  for (const request of requests) {
    assert.ok(request.url.endsWith('/feed-events-queue'));
    assert.deepEqual(weeks(request.body), [37, 38, 1, 2]);
    assert.deepEqual(request.body.boards.map(b => b.providerEventId), ['event-0','event-1','event-2','event-3']);
    assert.ok(request.body.boards.every(b => b.matches.length === 10 && b.matches.every(m => m.leagueId === request.body.leagueId)));
  }
});

test('actual result ledger requires ten scored fixtures and completion remains league qualified', async () => {
  const json = feed();
  json.events[0].a = 'ledger-completion-regression';
  const board = parseFeedEventsBoards(json, '78')[0];
  registerResultLedgerEventBoard(board);
  const { monitor, queues } = harness({ isComplete: hasCompleteBoardResults });
  const results = { leagueId: '78', providerEventId: board.providerEventId,
    matches: board.events.map(b => ({ providerMatchId: b.providerMatchId, homeScore: 1, awayScore: 0 })) };
  recordResultLedgerObservation({}, { ...results, matches: results.matches.slice(0, 9) });
  await monitor.ingest(json, '78', start + 1);
  assert.deepEqual(weeks(queues.at(-1)), [37,38,1,2]);
  recordResultLedgerObservation({}, results);
  assert.equal(hasCompleteBoardResults(board), true);
  assert.equal(hasCompleteBoardResults({ ...board, leagueId: '21' }), false);
  await monitor.ingest(json, '78', start + 2);
  assert.deepEqual(weeks(queues.at(-1)), [38,1,2]);
});
