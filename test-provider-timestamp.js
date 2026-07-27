const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeProviderTimestamp } = require('./provider-timestamp');
const {
  postCanonicalBoardIfValid,
  validateCanonicalBoard,
} = require('./canonical-board-guard');

const unixSeconds = 1783929337;
const unixMilliseconds = unixSeconds * 1000;
const expectedIso = new Date(unixMilliseconds).toISOString();

test('normalizes supported provider timestamp representations', () => {
  assert.equal(
    normalizeProviderTimestamp('2026-07-13T07:55:37.000Z'),
    '2026-07-13T07:55:37.000Z',
  );
  assert.equal(normalizeProviderTimestamp(unixSeconds), expectedIso);
  assert.equal(normalizeProviderTimestamp(unixMilliseconds), expectedIso);
  assert.equal(normalizeProviderTimestamp(String(unixSeconds)), expectedIso);
  assert.equal(normalizeProviderTimestamp(String(unixMilliseconds)), expectedIso);
  assert.equal(normalizeProviderTimestamp(new Date(unixMilliseconds)), expectedIso);
});

test('rejects malformed, placeholder, impossible, and missing timestamps', () => {
  assert.equal(normalizeProviderTimestamp(''), null);
  assert.equal(normalizeProviderTimestamp('   '), null);
  assert.equal(normalizeProviderTimestamp('invalid-value'), null);
  assert.equal(normalizeProviderTimestamp('null'), null);
  assert.equal(normalizeProviderTimestamp('undefined'), null);
  assert.equal(normalizeProviderTimestamp('NaN'), null);
  assert.equal(normalizeProviderTimestamp('Invalid Date'), null);
  assert.equal(normalizeProviderTimestamp('2026-02-30T12:00:00Z'), null);
  assert.equal(normalizeProviderTimestamp(undefined), null);
  assert.equal(normalizeProviderTimestamp(new Date('invalid')), null);
});

function event(index, startTime = expectedIso) {
  return {
    providerMatchId: `match-${index}`,
    homeTeam: `Home ${index}`,
    awayTeam: `Away ${index}`,
    startTime,
  };
}

test('posts a valid 10-event board unchanged', async () => {
  const board = {
    providerEventId: 'board-valid',
    expectedMatchCount: 10,
    events: Array.from({ length: 10 }, (_, index) => event(index)),
  };
  let postCount = 0;

  const result = await postCanonicalBoardIfValid(board, async (postedBoard) => {
    postCount += 1;
    assert.equal(postedBoard.events.length, 10);
    assert.equal(postedBoard.expectedMatchCount, 10);
    return { ok: true };
  });

  assert.equal(result.posted, true);
  assert.equal(postCount, 1);
});

test('blocks an invalid board without shrinking it or changing ExpectedMatchCount', async () => {
  const board = {
    providerEventId: 'board-invalid',
    expectedMatchCount: 10,
    events: Array.from({ length: 10 }, (_, index) => (
      event(index, index === 6 ? 'invalid-value' : expectedIso)
    )),
  };
  let postCount = 0;
  const originalError = console.error;
  console.error = () => {};

  let result;
  try {
    result = await postCanonicalBoardIfValid(board, async () => {
      postCount += 1;
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.posted, false);
  assert.equal(result.blocked, true);
  assert.equal(postCount, 0);
  assert.equal(board.events.length, 10);
  assert.equal(board.expectedMatchCount, 10);
  assert.equal(result.validation.eventCount, 10);
  assert.equal(result.validation.validEventCount, 9);
  assert.deepEqual(result.validation.invalidEvents[0].invalidReasons, ['invalid-startTime']);
  assert.equal(validateCanonicalBoard(board).valid, false);
});
