const assert = require('node:assert/strict');
const test = require('node:test');
const { summarizeBoardMarkets } = require('./auto-sync');

test('summarizes common canonical market objects', () => {
  const summary = summarizeBoardMarkets({
    providerEventId: 'board-1',
    events: [{
      eventId: 'event-1',
      homeTeam: 'Home',
      awayTeam: 'Away',
      markets: {
        main: { home: 1, draw: 2, away: 3 },
        doubleChance: { homeDraw: 1, homeAway: 2, drawAway: 3 },
        bts: { yes: 1, no: 2 },
        overUnder: { over: 1, under: 2 },
      },
    }],
  });

  assert.deepEqual(summary.events[0].marketKeys, ['main', 'doubleChance', 'bts', 'overUnder']);
  assert.deepEqual(summary.events[0].selectionsByMarket.main, ['home', 'draw', 'away']);
});

test('summarizes homeOverUnder', () => {
  const summary = summarizeBoardMarkets({
    events: [{ markets: { homeOverUnder: { over05: 1, under05: 2 } } }],
  });

  assert.deepEqual(summary.events[0].selectionsByMarket.homeOverUnder, ['over05', 'under05']);
});

test('summarizes multiple queue boards independently', () => {
  const queue = {
    boards: [
      { providerEventId: 'one', matches: [{ markets: { main: { home: 1 } } }] },
      { providerEventId: 'two', matches: [{ markets: { bts: { yes: 1 } } }] },
    ],
  };
  const diagnosticBoards = queue.boards.map((board) => ({
    ...board,
    events: board.matches,
  }));

  assert.deepEqual(
    diagnosticBoards.map(summarizeBoardMarkets).map((board) => board.providerEventId),
    ['one', 'two'],
  );
  assert.deepEqual(diagnosticBoards[0].events[0].markets, { main: { home: 1 } });
});

test('handles a missing markets object', () => {
  const summary = summarizeBoardMarkets({ events: [{ eventId: 'event-1' }] });

  assert.deepEqual(summary.events[0].marketKeys, []);
  assert.deepEqual(summary.events[0].selectionsByMarket, {});
});

test('handles an empty events array', () => {
  const summary = summarizeBoardMarkets({ events: [] });

  assert.equal(summary.eventCount, 0);
  assert.deepEqual(summary.events, []);
});

test('does not mutate the payload', () => {
  const payload = {
    providerEventId: 'board-1',
    events: [{ markets: { main: { home: 1 } } }],
  };
  const before = structuredClone(payload);

  summarizeBoardMarkets(payload);

  assert.deepEqual(payload, before);
});
