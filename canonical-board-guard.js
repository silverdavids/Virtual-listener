const { normalizeProviderTimestamp } = require('./provider-timestamp');

function validateCanonicalBoard(board) {
  const events = Array.isArray(board?.events) ? board.events : [];
  const expectedMatchCount = board?.expectedMatchCount ?? events.length;
  const invalidEvents = [];

  events.forEach((event, index) => {
    const invalidReasons = [];
    if (!event?.providerMatchId) invalidReasons.push('missing-providerMatchId');
    if (!event?.homeTeam) invalidReasons.push('missing-homeTeam');
    if (!event?.awayTeam) invalidReasons.push('missing-awayTeam');
    if (!normalizeProviderTimestamp(event?.startTime)) invalidReasons.push('invalid-startTime');

    if (invalidReasons.length > 0) {
      invalidEvents.push({
        index,
        providerMatchId: event?.providerMatchId,
        homeTeam: event?.homeTeam,
        awayTeam: event?.awayTeam,
        startTime: event?.startTime,
        invalidReasons,
      });
    }
  });

  return {
    valid: events.length === expectedMatchCount && invalidEvents.length === 0,
    providerEventId: board?.providerEventId,
    expectedMatchCount,
    eventCount: events.length,
    validEventCount: events.length - invalidEvents.length,
    invalidEvents,
  };
}

function logBlockedCanonicalBoard(validation) {
  console.error('BOARD-CANONICAL-BLOCKED', {
    providerEventId: validation.providerEventId,
    expectedMatchCount: validation.expectedMatchCount,
    eventCount: validation.eventCount,
    validEventCount: validation.validEventCount,
    invalidEvents: validation.invalidEvents,
  });
}

async function postCanonicalBoardIfValid(board, post) {
  const validation = validateCanonicalBoard(board);
  if (!validation.valid) {
    logBlockedCanonicalBoard(validation);
    return { posted: false, blocked: true, validation };
  }

  return { posted: true, result: await post(board), validation };
}

module.exports = {
  validateCanonicalBoard,
  logBlockedCanonicalBoard,
  postCanonicalBoardIfValid,
};
