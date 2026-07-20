export class ApiError extends Error {
  constructor({ platform, status, code, body, url, retryAfter }) {
    super(`${platform} API error ${status}${code ? ` (${code})` : ''} for ${url}`);
    this.name = 'ApiError';
    this.platform = platform;
    this.status = status;
    this.code = code;
    this.body = body;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

/** Thrown when a refresh token is expired/revoked — the service must re-auth. */
export class AuthRequiredError extends Error {
  constructor(platform, detail) {
    super(`${platform} authorization expired or revoked — run "musicsync auth" again${detail ? ` (${detail})` : ''}`);
    this.name = 'AuthRequiredError';
    this.platform = platform;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractErrorCode(body) {
  if (!body || typeof body !== 'object') return undefined;
  // Spotify: {error: {status, message}} or {error, error_description}; TIDAL JSON:API: {errors: [{code, ...}]}
  return body.errors?.[0]?.code ?? body.error?.message ?? (typeof body.error === 'string' ? body.error : undefined);
}

/**
 * fetch wrapper with a token-bucket throttle, Retry-After-honoring retries,
 * and JSON/JSON:API handling. All waiting goes through the injectable
 * `sleep` so tests can run instantly.
 */
export function createHttpClient({
  platform,
  rps = 4,
  burst,
  retryOn403 = false,
  logger,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = Date.now,
}) {
  const capacity = burst ?? Math.max(1, Math.ceil(rps));
  let tokens = capacity;
  let lastRefill = now();
  let queue = Promise.resolve();

  async function takeToken() {
    const elapsed = (now() - lastRefill) / 1000;
    tokens = Math.min(capacity, tokens + elapsed * rps);
    lastRefill = now();
    if (tokens < 1) {
      const waitMs = Math.ceil(((1 - tokens) / rps) * 1000);
      await sleep(waitMs);
      tokens = Math.min(capacity, tokens + (waitMs / 1000) * rps);
    }
    tokens -= 1;
  }

  function throttled(fn) {
    const run = queue.then(takeToken).then(fn);
    // Keep the chain alive on failure; callers see the rejection via `run`.
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function parseBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function request(url, {
    method = 'GET',
    headers = {},
    json,
    form,
    auth,
    maxAttempts = 5,
  } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await throttled(() => undefined);

      const reqHeaders = { ...headers };
      if (auth) reqHeaders.Authorization = await auth();
      let body;
      if (json !== undefined) {
        reqHeaders['Content-Type'] ??= 'application/json';
        body = JSON.stringify(json);
      } else if (form !== undefined) {
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      }

      let res;
      try {
        res = await fetchImpl(url, { method, headers: reqHeaders, body });
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) throw err;
        const backoff = Math.min(2 ** attempt, 30) * 1000 * (1 + Math.random() * 0.25);
        logger?.warn(`${platform} network error, retrying`, { url, attempt, error: String(err) });
        await sleep(backoff);
        continue;
      }

      if (res.ok) {
        if (res.status === 204) return null;
        return parseBody(res);
      }

      const bodyParsed = await parseBody(res);
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfter = retryAfterHeader !== null && retryAfterHeader !== '' ? Number(retryAfterHeader) : undefined;
      const error = new ApiError({
        platform,
        status: res.status,
        code: extractErrorCode(bodyParsed),
        body: bodyParsed,
        url,
        retryAfter,
      });

      const rateLimited = res.status === 429 || (retryOn403 && res.status === 403);
      const serverError = res.status >= 500;
      if ((rateLimited || serverError) && attempt < maxAttempts) {
        const backoff = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(2 ** attempt, 30) * 1000 * (1 + Math.random() * 0.25);
        logger?.warn(`${platform} ${res.status}, backing off`, { url, attempt, backoffMs: Math.round(backoff) });
        lastError = error;
        await sleep(backoff);
        continue;
      }
      throw error;
    }
    throw lastError;
  }

  return { request };
}
