'use strict';

// Never forward arbitrary server text: SQL/proxy errors can contain credentials.
const SAFE_MESSAGES = new Set([
  'Live state could not be persisted.',
  'Invalid league-qualified live-state payload',
  'Invalid match minute',
]);
const MAX_BODY_BYTES = 4096;
const READ_TIMEOUT_MS = 500;

async function readErrorFields(response) {
  let reader;
  let timer;
  try {
    reader = response.body?.getReader();
    if (!reader) return null;
    const read = async () => {
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) return null;
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    return await Promise.race([
      read(),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}

async function liveStatePostError(response, payload) {
  const mediaType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const contentType = ['application/json', 'application/problem+json', 'text/html', 'text/plain'].includes(mediaType)
    ? mediaType : 'unknown';
  const body = contentType === 'application/json' || contentType === 'application/problem+json'
    ? await readErrorFields(response) : null;
  // Provider IDs are numeric. Reject control characters and unexpected text.
  const eventId = String(payload.providerEventId ?? '');
  const diagnostic = {
    status: Number.isInteger(response.status) ? response.status : null,
    contentType,
    code: body?.code === 'live_state_unavailable' ? body.code : 'unrecognized_error',
    message: SAFE_MESSAGES.has(body?.message) ? body.message : 'Response detail suppressed.',
    leagueId: ['21', '78'].includes(String(payload.leagueId)) ? String(payload.leagueId) : 'unknown',
    providerEventId: /^\d{1,100}$/.test(eventId) ? eventId : 'unknown',
  };
  return new Error(`live state HTTP ${diagnostic.status} ${JSON.stringify(diagnostic)}`);
}

module.exports = { liveStatePostError };
