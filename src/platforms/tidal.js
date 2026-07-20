import crypto from 'node:crypto';
import { createHttpClient, ApiError, AuthRequiredError } from '../http.js';
import { computeWriteStrategy, chunk } from '../diff.js';

const AUTH_BASE = 'https://auth.tidal.com/v1/oauth2';
const LOGIN_AUTHORIZE = 'https://login.tidal.com/authorize';
const API = 'https://openapi.tidal.com/v2';
export const TIDAL_SCOPES = 'playlists.read playlists.write user.read';

const JSONAPI = 'application/vnd.api+json';

/** 'PT1H2M3S' → milliseconds. TIDAL v2 durations are ISO-8601. */
export function parseIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso ?? '');
  if (!m) return null;
  const [, h, min, s] = m;
  return Math.round(((Number(h) || 0) * 3600 + (Number(min) || 0) * 60 + (Number(s) || 0)) * 1000);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function generatePkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function resolveNext(next) {
  if (!next) return null;
  if (next.startsWith('http')) return next;
  return API + next.replace(/^\/v2/, '');
}

/** Index JSON:API `included` resources by `type:id`. */
function indexIncluded(included = []) {
  const map = new Map();
  for (const res of included) map.set(`${res.type}:${res.id}`, res);
  return map;
}

function trackFromResource(resource, included) {
  const attrs = resource.attributes ?? {};
  const artistRefs = resource.relationships?.artists?.data ?? [];
  const albumRefs = resource.relationships?.albums?.data ?? [];
  return {
    id: resource.id,
    isrc: attrs.isrc ?? null,
    title: attrs.title,
    version: attrs.version ?? null,
    artists: artistRefs
      .map((ref) => included.get(`${ref.type}:${ref.id}`)?.attributes?.name)
      .filter(Boolean),
    album: albumRefs
      .map((ref) => included.get(`${ref.type}:${ref.id}`)?.attributes?.title)
      .filter(Boolean)[0] ?? null,
    durationMs: parseIsoDuration(attrs.duration),
    isLocal: false,
  };
}

export function createTidalAdapter({ config, tokens, logger, fetchImpl, sleep }) {
  const log = logger.child('tidal');
  // TIDAL is Beta with undocumented limits; history suggests ~1 req/s and
  // rate-limit responses on 403 as well as 429.
  const http = createHttpClient({ platform: 'tidal', rps: 1, burst: 3, retryOn403: true, logger: log, fetchImpl, sleep });
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let cachedUser = null;

  const basicAuth = () =>
    `Basic ${Buffer.from(`${config.tidal.clientId}:${config.tidal.clientSecret}`).toString('base64')}`;

  // --- user token (Authorization Code + PKCE; public client, no secret) ---
  async function ensureUserToken() {
    const stored = tokens.get('tidal');
    if (!stored?.refreshToken) throw new AuthRequiredError('tidal', 'no refresh token stored');
    if (stored.accessToken && stored.expiresAt && Date.parse(stored.expiresAt) - 60_000 > Date.now()) {
      return stored.accessToken;
    }
    let res;
    try {
      res = await http.request(`${AUTH_BASE}/token`, {
        method: 'POST',
        form: {
          grant_type: 'refresh_token',
          refresh_token: stored.refreshToken,
          client_id: config.tidal.clientId,
        },
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        throw new AuthRequiredError('tidal', JSON.stringify(err.body));
      }
      throw err;
    }
    const updated = tokens.set('tidal', {
      accessToken: res.access_token,
      expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
      // TIDAL rotates refresh tokens sometimes; always keep the newest.
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
    });
    return updated.accessToken;
  }

  // --- client-credentials token for catalog reads (/tracks, /searchResults):
  // the multi-track catalog endpoints gate user tokens behind an internal-tier
  // scope, so third-party apps use an app token there instead. ---
  async function ensureCatalogToken() {
    const stored = tokens.get('tidal-cc');
    if (stored?.accessToken && stored.expiresAt && Date.parse(stored.expiresAt) - 60_000 > Date.now()) {
      return stored.accessToken;
    }
    const res = await http.request(`${AUTH_BASE}/token`, {
      method: 'POST',
      form: { grant_type: 'client_credentials' },
      auth: async () => basicAuth(),
    });
    const updated = tokens.set('tidal-cc', {
      accessToken: res.access_token,
      expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
    });
    return updated.accessToken;
  }

  const userBearer = async () => `Bearer ${await ensureUserToken()}`;
  const catalogBearer = async () => `Bearer ${await ensureCatalogToken()}`;

  const acceptHeaders = { Accept: JSONAPI };

  async function getJson(url, auth) {
    return http.request(url, { headers: acceptHeaders, auth });
  }

  /** Walk JSON:API cursor pagination (links.next) to exhaustion. */
  async function* pages(firstUrl, auth) {
    let url = firstUrl;
    while (url) {
      const page = await getJson(url, auth);
      yield page;
      url = resolveNext(page?.links?.next);
    }
  }

  /**
   * Mutation with Idempotency-Key + TIDAL 409 semantics. The key is minted
   * ONCE per logical mutation and reused across every retry: a 409 /
   * IDEMPOTENT_REQUEST_IN_PROGRESS means the same-key request is still being
   * processed, and replaying the same key lets the server dedupe it —
   * a fresh key would double-apply the mutation.
   */
  async function mutate(url, { method, json }) {
    const idempotencyKey = crypto.randomUUID();
    for (let attempt = 1; ; attempt++) {
      try {
        return await http.request(url, {
          method,
          json,
          headers: { ...acceptHeaders, 'Content-Type': JSONAPI, 'Idempotency-Key': idempotencyKey },
          auth: userBearer,
        });
      } catch (err) {
        if (err instanceof ApiError
          && (err.status === 409 || err.code === 'IDEMPOTENT_REQUEST_IN_PROGRESS')
          && attempt < 3) {
          log.warn('idempotent request in progress, replaying same key', { url, attempt });
          await wait(2000);
          continue;
        }
        throw err;
      }
    }
  }

  const isItemRejection = (err) => err instanceof ApiError && err.status === 422
    && ['DUPLICATE_ITEMS_IN_COLLECTION', 'TOO_MANY_ITEMS_IN_COLLECTION'].includes(err.code);

  async function getCurrentUser() {
    if (!cachedUser) {
      const res = await getJson(`${API}/users/me`, userBearer);
      cachedUser = {
        id: res.data.id,
        country: res.data.attributes?.country ?? 'US',
      };
    }
    return cachedUser;
  }

  async function countryCode() {
    try {
      return (await getCurrentUser()).country;
    } catch (err) {
      if (err instanceof AuthRequiredError) return 'US';
      throw err;
    }
  }

  /** Lightweight item refs (track id + per-entry itemId) without includes. */
  async function fetchItemRefs(playlistId) {
    const refs = [];
    for await (const page of pages(`${API}/playlists/${playlistId}/relationships/items`, userBearer)) {
      for (const entry of page.data ?? []) {
        refs.push({ id: entry.id, type: entry.type, itemId: entry.meta?.itemId });
      }
    }
    return refs;
  }

  /**
   * Append tracks in 50-chunks. A 422 item rejection fails the whole chunk
   * on TIDAL's side, so fall back to per-item appends — silently losing a
   * chunk would be locked in by the engine's change-token bookkeeping.
   * Outcome per item: DUPLICATE means the track IS in the playlist (present,
   * not lost); TOO_MANY (or other item rejection) means genuinely absent.
   * Returns {absent: [trackIds]} for the caller's bookkeeping.
   */
  async function appendItems(playlistId, trackIds) {
    const url = `${API}/playlists/${playlistId}/relationships/items`;
    const absent = [];
    for (const part of chunk(trackIds, 50)) {
      try {
        await mutate(url, { method: 'POST', json: { data: part.map((id) => ({ id, type: 'tracks' })) } });
      } catch (err) {
        if (!isItemRejection(err)) throw err;
        log.warn('chunk rejected, retrying items individually', { playlist: playlistId, code: err.code });
        for (const id of part) {
          try {
            await mutate(url, { method: 'POST', json: { data: [{ id, type: 'tracks' }] } });
          } catch (itemErr) {
            if (!isItemRejection(itemErr)) throw itemErr;
            if (itemErr.code === 'DUPLICATE_ITEMS_IN_COLLECTION') {
              log.debug('item already in playlist', { playlist: playlistId, trackId: id });
            } else {
              absent.push(id);
              log.warn('item rejected by tidal', { playlist: playlistId, trackId: id, code: itemErr.code });
            }
          }
        }
      }
    }
    return { absent };
  }

  return {
    platform: 'tidal',
    getCurrentUser,

    async listOwnPlaylists() {
      const out = [];
      for await (const page of pages(`${API}/playlists?filter[owners.id]=me`, userBearer)) {
        for (const p of page.data ?? []) out.push({ id: p.id, name: p.attributes?.name });
      }
      return out;
    },

    async getPlaylistMeta(id) {
      const res = await getJson(`${API}/playlists/${id}`, userBearer);
      const attrs = res.data?.attributes ?? {};
      return {
        id: res.data?.id,
        name: attrs.name,
        // No snapshot_id equivalent — combine last-modified and item count.
        changeToken: `${attrs.lastModifiedAt ?? ''}|${attrs.numberOfItems ?? ''}`,
      };
    },

    async getPlaylistItems(id) {
      const out = [];
      const first = `${API}/playlists/${id}/relationships/items?include=items,items.artists,items.albums`;
      for await (const page of pages(first, userBearer)) {
        const included = indexIncluded(page.included);
        for (const entry of page.data ?? []) {
          if (entry.type !== 'tracks') {
            // Videos can't sync, but they must stay visible to the diff under
            // a non-colliding pseudo-id — otherwise a hand-added video would
            // survive forever despite the tool-owned-playlist contract.
            out.push({
              id: `${entry.type}:${entry.id}`, itemId: entry.meta?.itemId, isVideo: true,
              isrc: null, title: null, version: null, artists: [], album: null, durationMs: null, isLocal: false,
            });
            continue;
          }
          const resource = included.get(`tracks:${entry.id}`);
          if (!resource) {
            log.warn('playlist item missing included track resource', { playlist: id, trackId: entry.id });
            continue;
          }
          out.push({ ...trackFromResource(resource, included), itemId: entry.meta?.itemId });
        }
      }
      return out;
    },

    async createPlaylist({ name, description }) {
      const res = await mutate(`${API}/playlists`, {
        method: 'POST',
        json: {
          data: {
            type: 'playlists',
            attributes: { name, description, accessType: config.tidal.accessType },
          },
        },
      });
      return { id: res.data.id };
    },

    async setPlaylistItems(id, trackIds, currentItems) {
      // TIDAL playlists cannot hold the same track twice
      // (DUPLICATE_ITEMS_IN_COLLECTION), so duplicates in the master collapse
      // to their first occurrence here.
      const target = [...new Set(trackIds)];
      if (target.length < trackIds.length) {
        log.info('collapsed duplicate tracks for tidal', { id, duplicates: trackIds.length - target.length });
      }
      const strategy = computeWriteStrategy(target, currentItems.map((t) => t.id));
      if (strategy.type === 'skip') {
        log.debug('playlist already in sync', { id });
        return { dropped: 0 };
      }
      if (strategy.type === 'append') {
        const { absent } = await appendItems(id, strategy.toAppend);
        log.info('appended tracks', { id, count: strategy.toAppend.length - absent.length, dropped: absent.length || undefined });
        return { dropped: absent.length };
      }
      // Clear-and-rebuild keeps the playlist id stable and avoids the
      // 20-item reorder endpoint and its undocumented positionBefore
      // semantics. Item ids are re-fetched immediately before deletion.
      const refs = await fetchItemRefs(id);
      for (const part of chunk(refs, 50)) {
        await mutate(`${API}/playlists/${id}/relationships/items`, {
          method: 'DELETE',
          json: { data: part.map((r) => ({ id: r.id, type: r.type, meta: { itemId: r.itemId } })) },
        });
      }
      const { absent } = await appendItems(id, target);
      log.info('rebuilt playlist', { id, removed: refs.length, added: target.length - absent.length, dropped: absent.length || undefined });
      return { dropped: absent.length };
    },

    /** Set-style append for two-way sync. Returns {absent: [trackIds]} that could not land. */
    async addTracks(id, trackIds) {
      return appendItems(id, [...new Set(trackIds)]);
    },

    /** Set-style removal for two-way sync. Entries: [{id, itemId}] — itemId from a fresh items fetch. */
    async removeTracks(id, entries) {
      const withItemId = entries.filter((e) => e.itemId);
      if (withItemId.length < entries.length) {
        log.warn('skipping removals without itemId', { id, skipped: entries.length - withItemId.length });
      }
      for (const part of chunk(withItemId, 50)) {
        await mutate(`${API}/playlists/${id}/relationships/items`, {
          method: 'DELETE',
          json: { data: part.map((e) => ({ id: e.id, type: 'tracks', meta: { itemId: e.itemId } })) },
        });
      }
    },

    async findTracksByIsrc(isrc) {
      const cc = await countryCode();
      const first = `${API}/tracks?countryCode=${cc}&filter[isrc]=${encodeURIComponent(isrc)}&include=artists`;
      // A single ISRC can match many pressings, paginated — walk every page
      // so the matcher's duration preference sees all candidates.
      const out = [];
      for await (const page of pages(first, catalogBearer)) {
        const included = indexIncluded(page.included);
        out.push(...(page.data ?? []).map((t) => trackFromResource(t, included)));
      }
      return out;
    },

    async searchTracks({ title, artist, album }) {
      const cc = await countryCode();
      const queries = [];
      if (album && artist) queries.push(`${album} ${artist}`);
      if (title && artist) queries.push(`${title} ${artist}`);
      if (queries.length === 0 && title) queries.push(title);
      const seen = new Map();
      for (const q of queries) {
        const url = `${API}/searchResults/${encodeURIComponent(q)}?countryCode=${cc}&include=tracks,tracks.artists`;
        const res = await getJson(url, catalogBearer);
        const included = indexIncluded(res.included);
        const refs = res.data?.relationships?.tracks?.data ?? [];
        for (const ref of refs) {
          const resource = included.get(`tracks:${ref.id}`);
          if (resource && !seen.has(ref.id)) seen.set(ref.id, trackFromResource(resource, included));
        }
      }
      return [...seen.values()];
    },

    describeAuth() {
      const stored = tokens.get('tidal');
      if (!stored?.refreshToken) return { authorized: false };
      // TIDAL refresh-token lifetime is undocumented; no expiry countdown.
      return { authorized: true, authorizedAt: stored.authorizedAt ?? null, daysLeft: null, warn: false };
    },

    // --- auth bootstrap helpers ---
    buildAuthorizeUrl({ redirectUri, state, challenge }) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.tidal.clientId,
        redirect_uri: redirectUri,
        scope: TIDAL_SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
      });
      return `${LOGIN_AUTHORIZE}?${params}`;
    },

    async exchangeCode({ code, redirectUri, verifier }) {
      const res = await http.request(`${AUTH_BASE}/token`, {
        method: 'POST',
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: config.tidal.clientId,
          code_verifier: verifier,
        },
      });
      return tokens.set('tidal', {
        accessToken: res.access_token,
        expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
        refreshToken: res.refresh_token,
        authorizedAt: new Date().toISOString(),
      });
    },
  };
}
