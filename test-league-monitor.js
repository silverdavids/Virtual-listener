const test = require('node:test');
const assert = require('node:assert/strict');
const { createLeagueMonitor, leagueEventKey, selectCurrentBoard, createLeagueRefreshScheduler } = require('./league-monitor');
const {
  parseFeedEventsBoards, buildFeedEventsQueuePayload, postFeedEventsBoard,
  postFeedEventsQueue, getResultLedgerEntry, registerResultLedgerEventBoard,
  postResultMonitorPayloadWithLedger,
  recordResultLedgerObservation,
} = require('./auto-sync');

function feed(leagueId, eventId = 'shared-event', week = 1) {
  return { events: [{ a: eventId, d: '2026-09-06T12:00:00Z', e: '2026-09-06T12:03:00Z',
    f: { b: { a: { a: { d: leagueId, a: leagueId === '21' ? 'Champions' : 'EPL' } },
      c: { e: 9999, a: week, c: Array.from({ length: 10 }, (_, i) => ({ b: {
        a: `match-${i}`, i: { a: {
          b: { a: { a: `${leagueId}-home-${i}` }, b: { a: `${leagueId}-away-${i}` } },
          c: [{ name: '1X2', selections: [{ name: '1', odd: 2 }] }],
        } },
      } })) } } } }] };
}

function harness(overrides = {}) {
  const posts = [], queues = [];
  const monitor = createLeagueMonitor({
    parseBoards: parseFeedEventsBoards, buildQueue: buildFeedEventsQueuePayload,
    postQueue: async queue => { queues.push(queue); },
    postBoard: async board => { posts.push(board); return { posted: true }; },
    log: () => {}, ...overrides,
  });
  return { monitor, posts, queues };
}

test('passed starts do not expire boards or reorder provider queue', () => {
  const boards = [1000, 4000, 3000].map(start => ({ providerEventId: String(start), startTime: new Date(start).toISOString() }));
  assert.equal(selectCurrentBoard(boards, 2000).providerEventId, '1000');
  assert.equal(selectCurrentBoard(boards, 5000).providerEventId, '1000');
});

test('competition identity is separate from season and conflicting response identity is rejected', () => {
  const board = parseFeedEventsBoards(feed('78'), '78')[0];
  assert.equal(board.leagueId, '78');
  assert.equal(board.leagueNumber, '9999');
  assert.equal(board.events[0].leagueId, '78');
  assert.equal(parseFeedEventsBoards(feed('21'), '78').length, 0);
  const missing = feed('78');
  delete missing.events[0].f.b.a.a.d;
  assert.equal(parseFeedEventsBoards(missing, '78')[0].leagueId, '78');
});

test('interleaved leagues with identical event IDs retain separate current boards and queues', async () => {
  const { monitor, posts, queues } = harness();
  await Promise.all([monitor.ingest(feed('21'), '21', 1), monitor.ingest(feed('78'), '78', 1)]);
  await Promise.all(Array.from({ length: 5 }, () => monitor.ingest(feed('21'), '21', 2)));
  assert.deepEqual(posts.map(board => board.leagueId).sort(), ['21', '78']);
  assert.equal(queues.length, 2);
  const epl = monitor.states.get('78').current;
  await monitor.ingest(feed('21', 'next-event', 2), '21', 3);
  assert.equal(monitor.states.get('78').current, epl);
  assert.equal(monitor.states.get('78').boards.get(leagueEventKey('78', 'shared-event')), epl);
  await monitor.ingest(feed('21'), '21', 0);
  assert.equal(monitor.states.get('21').current.providerEventId, 'next-event');
});

test('all queued weeks are retained and mixed-league queue imports are refused', async () => {
  const { monitor, queues } = harness();
  const json = { events: [...feed('21').events, ...feed('21', 'week-2', 2).events, ...feed('78').events] };
  await monitor.ingest(json);
  assert.deepEqual(queues.map(queue => [queue.leagueId, queue.boards.length]), [['21', 2], ['78', 1]]);
  assert.throws(() => buildFeedEventsQueuePayload(parseFeedEventsBoards(json), 1), /exactly one/);
});

test('failed imports retry without blocking the other league or duplicating successful boards', async () => {
  let queueAttempts = 0, boardAttempts = 0;
  const { monitor, posts } = harness({
    postQueue: async queue => { if (queue.leagueId === '21' && ++queueAttempts === 1) throw new Error('offline'); },
    postBoard: async board => {
      if (board.leagueId === '21' && ++boardAttempts === 1) return { posted: false };
      posts.push(board); return { posted: true };
    },
  });
  await monitor.ingest(feed('21'), '21', 1);
  await monitor.ingest(feed('78'), '78', 1);
  await monitor.ingest(feed('21'), '21', 2);
  await monitor.ingest(feed('21'), '21', 3);
  assert.equal(queueAttempts, 2);
  assert.equal(boardAttempts, 2);
  assert.equal(posts.length, 2);
});

test('refresh and new monitor session preserve both pending result ledger entries', async () => {
  const champion = registerResultLedgerEventBoard(parseFeedEventsBoards(feed('21', 'ledger-event'))[0]);
  const epl = registerResultLedgerEventBoard(parseFeedEventsBoards(feed('78', 'ledger-event'))[0]);
  assert.notEqual(champion, epl);
  champion.resultRowsByProviderMatchId.a = { homeScore: 1, awayScore: 0 };
  await harness().monitor.ingest(feed('21', 'new-board'), '21');
  assert.equal(getResultLedgerEntry('ledger-event', '78'), epl);
  assert.deepEqual(epl.resultRowsByProviderMatchId, {});
  assert.equal(getResultLedgerEntry('ledger-event', '21'), champion);
});

test('real posting functions send both leagues to all three endpoints and deduplicate results', async (t) => {
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (options.method === 'POST') requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, batchId: 'test-batch' }) };
  });
  const { monitor } = harness({
    postQueue: postFeedEventsQueue,
    postBoard: (board, state, capturedAt) => postFeedEventsBoard(1, board, state, { feedReceivedAt: capturedAt }),
    log: console.log,
  });
  for (const leagueId of ['21', '78']) {
    const json = feed(leagueId, 'integration-board');
    await monitor.ingest(json, leagueId);
    const entry = getResultLedgerEntry('integration-board', leagueId);
    const payload = { leagueId, providerEventId: 'integration-board', matches: Array.from({ length: 10 }, (_, index) => ({ providerMatchId: `match-${index}`, home: `${leagueId}-home-${index}`, away: `${leagueId}-away-${index}`, homeScore: 1, awayScore: 0 })) };
    assert.equal(recordResultLedgerObservation({ providerEventId: payload.providerEventId, resultsPayload: payload }, payload).isComplete, true);
    await Promise.all([postResultMonitorPayloadWithLedger(entry, payload), postResultMonitorPayloadWithLedger(entry, payload)]);
    await postResultMonitorPayloadWithLedger(entry, payload);
  }
  for (const endpoint of ['/events', '/feed-events-queue', '/results']) {
    assert.deepEqual(requests.filter(request => request.url.endsWith(endpoint)).map(request => request.body.leagueId).sort(), ['21', '78']);
  }
});

test('duplicate result captures respect the result retry ledger after a failed import', async (t) => {
  let attempts = 0;
  t.mock.method(global, 'fetch', async () => {
    attempts += 1;
    return { ok: false, status: 409, statusText: 'Conflict', text: async () => 'Board was not found.' };
  });
  const entry = getResultLedgerEntry('retry-ledger-test', '78');
  const payload = { leagueId: '78', providerEventId: entry.providerEventId, matches: [] };
  await assert.rejects(postResultMonitorPayloadWithLedger(entry, payload), /409/);
  assert.equal((await postResultMonitorPayloadWithLedger(entry, payload)).deferred, true);
  assert.equal(attempts, 1);
  assert.equal(entry.status, 'RESULT_POST_FAILED');
});

test('a slow Champions refresh does not block EPL or either results poll', async () => {
  let clock = 0, release;
  const calls = [];
  const scheduler = createLeagueRefreshScheduler({
    now: () => clock,
    refreshLeague: async league => {
      calls.push(`feed-${league.id}`);
      if (league.id === '21') await new Promise(resolve => { release = resolve; });
    },
    pollResults: async league => { calls.push(`results-${league.id}`); },
  });
  const first = scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.sort(), ['feed-21', 'feed-78', 'results-21', 'results-78']);
  clock = 5000;
  await scheduler.tick();
  assert.equal(calls.filter(call => call === 'feed-21').length, 1);
  assert.equal(calls.filter(call => call === 'feed-78').length, 2);
  release();
  await first;
});

test('pending results do not delay feed refresh and duplicate ticks do not overlap results requests', async () => {
  let clock = 0;
  const releases = [], feeds = [], results = [];
  const scheduler = createLeagueRefreshScheduler({
    now: () => clock,
    refreshLeague: async league => { feeds.push(league.id); },
    pollResults: async league => {
      results.push(league.id);
      await new Promise(resolve => releases.push(resolve));
    },
  });
  const first = scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  clock = 5000;
  await scheduler.tick();
  assert.deepEqual(feeds, ['21', '78', '21', '78']);
  assert.deepEqual(results, ['21', '78']);
  releases.forEach(release => release());
  await first;
});

test('warm-up gates both leagues and re-login resets scheduling while invalidating old requests', async () => {
  let ready = false;
  const callbacks = [], releases = [];
  const scheduler = createLeagueRefreshScheduler({
    isReady: () => ready,
    refreshLeague: async (league, isCurrent) => {
      callbacks.push({ league: league.id, isCurrent });
      await new Promise(resolve => releases.push(resolve));
    },
    pollResults: async () => {},
  });
  await scheduler.tick();
  assert.equal(callbacks.length, 0);
  ready = true;
  const initial = scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  scheduler.reset();
  assert.ok(callbacks.every(callback => !callback.isCurrent()));
  const restarted = scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(callbacks.slice(2).map(callback => callback.league), ['21', '78']);
  releases.slice(0, 2).forEach(release => release());
  await initial;
  assert.ok(scheduler.states.get('21').feed.inFlight);
  releases.slice(2).forEach(release => release());
  await restarted;
});

test('an ingestion queued before re-login cannot post a board after session invalidation', async () => {
  let current = true, release;
  const posts = [];
  const { monitor } = harness({
    postQueue: async () => { await new Promise(resolve => { release = resolve; }); },
    postBoard: async board => { posts.push(board); return { posted: true }; },
  });
  const work = monitor.ingest(feed('21'), '21', Date.now(), () => current);
  await new Promise(resolve => setImmediate(resolve));
  current = false;
  release();
  await work;
  assert.equal(posts.length, 0);
});
