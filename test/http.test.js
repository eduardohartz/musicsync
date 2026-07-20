import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, ApiError } from '../src/http.js';

function mockFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status < 400,
      status: next.status,
      headers: { get: (h) => next.headers?.[h] ?? null },
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    };
  };
  return { impl, calls };
}

const instantSleep = () => {
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); } };
};

function client(fetchMock, sleeper, extra = {}) {
  return createHttpClient({
    platform: 'test',
    rps: 1000,
    fetchImpl: fetchMock.impl,
    sleep: sleeper.sleep,
    ...extra,
  });
}

test('success path parses JSON', async () => {
  const f = mockFetch([{ status: 200, body: { ok: 1 } }]);
  const http = client(f, instantSleep());
  assert.deepEqual(await http.request('https://x/y'), { ok: 1 });
});

test('204 returns null', async () => {
  const f = mockFetch([{ status: 204 }]);
  const http = client(f, instantSleep());
  assert.equal(await http.request('https://x/y'), null);
});

test('429 honors Retry-After seconds', async () => {
  const s = instantSleep();
  const f = mockFetch([
    { status: 429, headers: { 'Retry-After': '7' } },
    { status: 200, body: { done: true } },
  ]);
  const http = client(f, s);
  assert.deepEqual(await http.request('https://x/y'), { done: true });
  assert.ok(s.slept.includes(7000), `expected 7000ms sleep, got ${s.slept}`);
});

test('403 retried only when retryOn403', async () => {
  const s1 = instantSleep();
  const f1 = mockFetch([{ status: 403, body: { errors: [{ code: 'RATE' }] } }, { status: 200, body: {} }]);
  await client(f1, s1, { retryOn403: true }).request('https://x/y');
  assert.equal(f1.calls.length, 2);

  const f2 = mockFetch([{ status: 403, body: {} }]);
  await assert.rejects(
    () => client(f2, instantSleep()).request('https://x/y'),
    (err) => err instanceof ApiError && err.status === 403,
  );
  assert.equal(f2.calls.length, 1);
});

test('400 throws immediately with body and code', async () => {
  const f = mockFetch([{ status: 400, body: { error: 'invalid_grant' } }]);
  await assert.rejects(
    () => client(f, instantSleep()).request('https://x/y'),
    (err) => err instanceof ApiError && err.status === 400 && err.code === 'invalid_grant',
  );
});

test('5xx retries up to maxAttempts then throws', async () => {
  const f = mockFetch(Array.from({ length: 5 }, () => ({ status: 502, body: {} })));
  await assert.rejects(
    () => client(f, instantSleep()).request('https://x/y', { maxAttempts: 5 }),
    (err) => err instanceof ApiError && err.status === 502,
  );
  assert.equal(f.calls.length, 5);
});

test('network error retries then succeeds', async () => {
  const f = mockFetch([new Error('ECONNRESET'), { status: 200, body: { ok: 1 } }]);
  assert.deepEqual(await client(f, instantSleep()).request('https://x/y'), { ok: 1 });
});

test('form bodies are urlencoded and auth evaluated per attempt', async () => {
  let authCalls = 0;
  const f = mockFetch([{ status: 500, body: {} }, { status: 200, body: {} }]);
  await client(f, instantSleep()).request('https://x/y', {
    method: 'POST',
    form: { grant_type: 'refresh_token', refresh_token: 'r t' },
    auth: async () => { authCalls++; return 'Basic abc'; },
  });
  assert.equal(authCalls, 2);
  assert.equal(f.calls[0].opts.body, 'grant_type=refresh_token&refresh_token=r+t');
  assert.equal(f.calls[0].opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Basic abc');
});

test('throttle spaces requests at configured rps', async () => {
  const slept = [];
  const f = mockFetch(Array.from({ length: 3 }, () => ({ status: 200, body: {} })));
  const http = createHttpClient({
    platform: 'test',
    rps: 2,
    burst: 1,
    fetchImpl: f.impl,
    sleep: async (ms) => { slept.push(ms); },
  });
  await http.request('https://x/1');
  await http.request('https://x/2');
  await http.request('https://x/3');
  // First request consumes the single burst token; the next two must each wait ~500ms.
  assert.equal(slept.filter((ms) => ms >= 400 && ms <= 600).length, 2, `sleeps: ${slept}`);
});
