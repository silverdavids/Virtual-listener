const test = require('node:test');
const assert = require('node:assert/strict');
const { liveStatePostError } = require('./live-state-post-error');
const identity = { leagueId: '21', providerEventId: '782767201' };
const response = (body, type = 'application/json; charset=utf-8') => new Response(body, {
  status: 503, headers: { 'content-type': type, 'set-cookie': 'secret-cookie' },
});

test('503 retry diagnostic retains only safe fields and identity', async () => {
  const error = await liveStatePostError(response(JSON.stringify({
    success: false, code: 'live_state_unavailable', message: 'Live state could not be persisted.',
    authorization: 'Bearer secret-token', connectionString: 'secret-connection', payload: 'secret-payload',
  })), identity);
  const log = `LIVE-STATE-RETRY reason=${error.message}`;
  for (const expected of ['503', 'application/json', 'live_state_unavailable',
    'Live state could not be persisted.', '"leagueId":"21"', '"providerEventId":"782767201"']) {
    assert.ok(log.includes(expected));
  }
  assert.doesNotMatch(log, /secret|authorization|connectionString|payload|cookie/i);
  assert.ok(log.length < 512);
});

test('arbitrary SQL errors and injected fields are suppressed', async () => {
  const secret = 'Password=secret; Authorization: Bearer secret\r\nCookie: secret';
  const error = await liveStatePostError(response(JSON.stringify({code: secret, message: secret})), {
    leagueId: secret, providerEventId: secret,
  });
  assert.doesNotMatch(error.message, /secret|Password|Authorization|Cookie|\r|\n/);
  assert.match(error.message, /Response detail suppressed/);
});

test('HTML, malformed JSON, missing type and hostile content types never leak bodies', async () => {
  for (const type of ['text/html', 'application/json', '', 'secret/type; token=secret']) {
    const error = await liveStatePostError(response('<html>secret</html>', type), identity);
    assert.doesNotMatch(error.message, /secret|<html>/);
    assert.match(error.message, /503/);
  }
});

test('oversized response and message are bounded and suppressed', async () => {
  for (const length of [1000, 5000]) {
    const error = await liveStatePostError(response(JSON.stringify({message: 'secret'.repeat(length)})), identity);
    assert.doesNotMatch(error.message, /secret/);
    assert.ok(error.message.length < 512);
  }
});

test('failed or stalled body reads retain status without logging read errors', async () => {
  for (const stream of [
    new ReadableStream({start(controller) { controller.error(new Error('secret')); }}),
    new ReadableStream({start() {}}),
  ]) {
    const error = await liveStatePostError(response(stream), identity);
    assert.match(error.message, /503/);
    assert.doesNotMatch(error.message, /secret/);
  }
});

test('both leagues retain numeric event identity', async () => {
  const error = await liveStatePostError(response('{}'), {leagueId: 78, providerEventId: 12345});
  assert.match(error.message, /"leagueId":"78"/);
  assert.match(error.message, /"providerEventId":"12345"/);
});
