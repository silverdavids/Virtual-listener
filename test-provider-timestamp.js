const assert = require('node:assert');
const { normalizeProviderTimestamp } = require('./provider-timestamp');
const {
  postCanonicalBoardIfValid,
  validateCanonicalBoard,
} = require('./canonical-board-guard');

const seconds = 1783929337;
const milliseconds = seconds * 1000;
const expectedIso = new Date(milliseconds).toISOString();

assert.strictEqual(normalizeProviderTimestamp('2026-07-13T07:55:37.000Z'),
  '2026-07-13T07:55:37.000Z');
assert.strictEqual(normalizeProviderTimestamp(seconds), expectedIso);
assert.strictEqual(normalizeProviderTimestamp(milliseconds), expectedIso);
assert.strictEqual(normalizeProviderTimestamp(String(seconds)), expectedIso);
assert.strictEqual(normalizeProviderTimestamp(String(milliseconds)), expectedIso);
assert.strictEqual(normalizeProviderTimestamp(new Date(milliseconds)), expectedIso);
assert.strictEqual(normalizeProviderTimestamp(''), null);
assert.strictEqual(normalizeProviderTimestamp('invalid-value'), null);
assert.strictEqual(normalizeProviderTimestamp('2026-02-30T12:00:00Z'), null);
assert.strictEqual(normalizeProviderTimestamp(undefined), null);

function match(index, startTime = expectedIso) {
  return {
    providerMatchId: `match-${index}`,
    homeTeam: `Home ${index}`,
    awayTeam: `Away ${index}`,
    startTime,
  };
}

(async () => {
  const validBoard = {
    providerEventId: 'board-valid',
    expectedMatchCount: 10,
    events: Array.from({ length: 10 }, (_, index) => match(index)),
  };
  let postCount = 0;
  const posted = await postCanonicalBoardIfValid(validBoard, async (board) => {
    postCount += 1;
    assert.strictEqual(board.events.length, 10);
    assert.strictEqual(board.expectedMatchCount, 10);
    return { ok: true };
  });
  assert.strictEqual(posted.posted, true);
  assert.strictEqual(postCount, 1);

  const invalidBoard = {
    providerEventId: 'board-invalid',
    expectedMatchCount: 10,
    events: Array.from({ length: 10 }, (_, index) => (
      match(index, index === 6 ? 'invalid-value' : expectedIso)
    )),
  };
  const originalError = console.error;
  console.error = () => {};
  let blocked;
  try {
    blocked = await postCanonicalBoardIfValid(invalidBoard, async () => {
      postCount += 1;
    });
  } finally {
    console.error = originalError;
  }

  assert.strictEqual(blocked.posted, false);
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(postCount, 1, 'invalid board must not be posted');
  assert.strictEqual(invalidBoard.events.length, 10, 'invalid event must not be removed');
  assert.strictEqual(invalidBoard.expectedMatchCount, 10, 'expected count must not change');
  assert.strictEqual(blocked.validation.eventCount, 10);
  assert.strictEqual(blocked.validation.validEventCount, 9);
  assert.deepStrictEqual(
    blocked.validation.invalidEvents[0].invalidReasons,
    ['invalid-startTime']
  );
  assert.strictEqual(validateCanonicalBoard(invalidBoard).valid, false);

  console.log('Virtual Horizon timestamp normalization tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
