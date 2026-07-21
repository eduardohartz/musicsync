import { createHttpClient, ApiError, AuthRequiredError } from '../http.js';
import { computeWriteStrategy, chunk } from '../diff.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
export const SPOTIFY_SCOPES = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private';

// Development Mode apps (Feb 2026): playlist entry key renamed track -> item.
// Request both in `fields` and read `item ?? track` while the migration settles.
const ITEM_FIELDS = 'is_local,item(id,name,duration_ms,artists(name),album(name),external_ids(isrc)),track(id,name,duration_ms,artists(name),album(name),external_ids(isrc))';

const SIX_MONTHS_DAYS = 180;

function toTrack(entry) {
  const t = entry.item ?? entry.track;
  if (!t || !t.id) return null;
  return {
    id: t.id,
    isrc: t.external_ids?.isrc ?? null,
    title: t.name,
    version: null,
    artists: (t.artists ?? []).map((a) => a.name),
    album: t.album?.name ?? null,
    durationMs: t.duration_ms,
    isLocal: entry.is_local === true,
  };
}

export function createSpotifyAdapter({ config, tokens, logger, fetchImpl, sleep }) {
  const log = logger.child('spotify');
  const http = createHttpClient({ platform: 'spotify', rps: 4, logger: log, fetchImpl, sleep });
  let cachedUserId = null;

  const basicAuth = () =>
    `Basic ${Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64')}`;

  async function tokenRequest(form) {
    try {
      return await http.request(`${ACCOUNTS}/api/token`, {
        method: 'POST',
        form,
        auth: async () => basicAuth(),
      });
    } catch (err) {
      if (err instanceof ApiError && err.body?.error === 'invalid_grant') {
        throw new AuthRequiredError('spotify', err.body?.error_description ?? 'invalid_grant');
      }
      throw err;
    }
  }

  async function ensureAccessToken() {
    const stored = tokens.get('spotify');
    if (!stored?.refreshToken) throw new AuthRequiredError('spotify', 'no refresh token stored');
    if (stored.accessToken && stored.expiresAt && Date.parse(stored.expiresAt) - 60_000 > Date.now()) {
      return stored.accessToken;
    }
    const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: stored.refreshToken });
    const updated = tokens.set('spotify', {
      accessToken: res.access_token,
      expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
      // Rotation semantics are undocumented: persist the newest refresh token,
      // keep the old one when the response omits it.
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
    });
    return updated.accessToken;
  }

  const bearer = async () => `Bearer ${await ensureAccessToken()}`;

  async function* pages(firstUrl) {
    let url = firstUrl;
    while (url) {
      const page = await http.request(url, { auth: bearer });
      yield page;
      url = page?.next ?? null;
    }
  }

  async function getCurrentUser() {
    if (!cachedUserId) {
      const me = await http.request(`${API}/me`, { auth: bearer });
      cachedUserId = me.id;
    }
    // Dev mode no longer exposes profile country — market comes from ENV.
    return { id: cachedUserId, country: config.spotify.market };
  }

  return {
    platform: 'spotify',
    getCurrentUser,

    async listOwnPlaylists() {
      const { id: userId } = await getCurrentUser();
      const out = [];
      for await (const page of pages(`${API}/me/playlists?limit=50`)) {
        for (const p of page.items ?? []) {
          if (p?.owner?.id === userId) out.push({ id: p.id, name: p.name, count: p.tracks?.total ?? null });
        }
      }
      return out;
    },

    async getPlaylistMeta(id) {
      const p = await http.request(`${API}/playlists/${id}?fields=id,name,snapshot_id`, { auth: bearer });
      return { id: p.id, name: p.name, changeToken: p.snapshot_id };
    },

    async getPlaylistItems(id) {
      const out = [];
      const fields = encodeURIComponent(`next,items(${ITEM_FIELDS})`);
      for await (const page of pages(`${API}/playlists/${id}/items?limit=50&fields=${fields}`)) {
        for (const entry of page.items ?? []) {
          const track = toTrack(entry);
          if (track) out.push(track);
        }
      }
      return out;
    },

    async createPlaylist({ name, description }) {
      // Spotify has no idempotency mechanism: retrying an ambiguous failure
      // could create duplicate playlists / duplicate appends, so mutating
      // POSTs never replay 5xx/network errors (429 stays retryable — the
      // request was rejected, not processed). The next run repairs via diff.
      const p = await http.request(`${API}/me/playlists`, {
        method: 'POST',
        json: { name, public: config.spotify.playlistPublic, description },
        auth: bearer,
        retryAmbiguous: false,
      });
      return { id: p.id };
    },

    async setPlaylistItems(id, trackIds, currentItems) {
      const strategy = computeWriteStrategy(trackIds, currentItems.map((t) => t.id));
      const uris = (ids) => ids.map((tid) => `spotify:track:${tid}`);
      if (strategy.type === 'skip') {
        log.debug('playlist already in sync', { id });
        return;
      }
      if (strategy.type === 'append') {
        for (const part of chunk(strategy.toAppend, 100)) {
          await http.request(`${API}/playlists/${id}/items`, {
            method: 'POST',
            json: { uris: uris(part) },
            auth: bearer,
            retryAmbiguous: false, // appends are not idempotent on Spotify
          });
        }
        log.info('appended tracks', { id, count: strategy.toAppend.length });
        return;
      }
      // Full rewrite: PUT replaces the entire playlist with the first ≤100,
      // then POST appends the rest in 100-chunks. Avoids DELETE-by-URI, which
      // removes every occurrence of a URI (duplicate-unsafe).
      const parts = chunk(trackIds, 100);
      await http.request(`${API}/playlists/${id}/items`, {
        method: 'PUT',
        json: { uris: uris(parts[0] ?? []) },
        auth: bearer,
      });
      for (const part of parts.slice(1)) {
        await http.request(`${API}/playlists/${id}/items`, {
          method: 'POST',
          json: { uris: uris(part) },
          auth: bearer,
          retryAmbiguous: false, // appends are not idempotent on Spotify
        });
      }
      log.info('rewrote playlist', { id, count: trackIds.length });
    },

    /** Set-style append for two-way sync. Spotify has no duplicate restriction. */
    async addTracks(id, trackIds) {
      for (const part of chunk([...new Set(trackIds)], 100)) {
        await http.request(`${API}/playlists/${id}/items`, {
          method: 'POST',
          json: { uris: part.map((tid) => `spotify:track:${tid}`) },
          auth: bearer,
          retryAmbiguous: false, // appends are not idempotent on Spotify
        });
      }
      return { absent: [] };
    },

    /**
     * Set-style removal for two-way sync. Entries: [{id}]. Spotify's
     * remove-by-URI deletes every occurrence of the track — correct under
     * two-way's set semantics. Removal is idempotent, so retries stay on.
     * `snapshotId` pins the delete to the playlist state the caller diffed
     * (research §2.4); each response's snapshot_id chains into the next
     * chunk so a concurrent user edit isn't silently clobbered.
     */
    async removeTracks(id, entries, { snapshotId } = {}) {
      let snapshot = snapshotId;
      for (const part of chunk(entries, 100)) {
        const res = await http.request(`${API}/playlists/${id}/items`, {
          method: 'DELETE',
          json: {
            items: part.map((e) => ({ uri: `spotify:track:${e.id}` })),
            ...(snapshot ? { snapshot_id: snapshot } : {}),
          },
          auth: bearer,
        });
        snapshot = res?.snapshot_id ?? snapshot;
      }
    },

    async findTracksByIsrc(isrc) {
      const url = `${API}/search?q=${encodeURIComponent(`isrc:${isrc}`)}&type=track&limit=10&market=${config.spotify.market}`;
      const res = await http.request(url, { auth: bearer });
      return (res.tracks?.items ?? []).filter(Boolean).map((t) => ({
        id: t.id,
        isrc: t.external_ids?.isrc ?? null,
        title: t.name,
        version: null,
        artists: (t.artists ?? []).map((a) => a.name),
        durationMs: t.duration_ms,
      }));
    },

    async searchTracks({ title, artist, album }) {
      // Dev-mode search caps limit at 10 — use focused query formulations, not paging.
      const queries = [];
      if (album && artist) queries.push(`album:${album} artist:${artist}`);
      if (title && artist) queries.push(`track:${title} artist:${artist}`);
      if (queries.length === 0 && title) queries.push(title);
      const seen = new Map();
      for (const q of queries) {
        const url = `${API}/search?q=${encodeURIComponent(q)}&type=track&limit=10&market=${config.spotify.market}`;
        const res = await http.request(url, { auth: bearer });
        for (const t of res.tracks?.items ?? []) {
          if (t && !seen.has(t.id)) {
            seen.set(t.id, {
              id: t.id,
              isrc: t.external_ids?.isrc ?? null,
              title: t.name,
              version: null,
              artists: (t.artists ?? []).map((a) => a.name),
              durationMs: t.duration_ms,
            });
          }
        }
      }
      return [...seen.values()];
    },

    describeAuth() {
      const stored = tokens.get('spotify');
      if (!stored?.refreshToken) return { authorized: false };
      const authorizedAt = stored.authorizedAt ?? null;
      const daysSince = authorizedAt ? (Date.now() - Date.parse(authorizedAt)) / 86_400_000 : null;
      const daysLeft = daysSince === null ? null : Math.floor(SIX_MONTHS_DAYS - daysSince);
      return {
        authorized: true,
        authorizedAt,
        daysLeft,
        // Spotify refresh tokens hard-expire 6 months after authorization.
        warn: daysLeft !== null && daysLeft <= 30,
      };
    },

    // --- OAuth helpers (used by the web panel) ---
    buildAuthorizeUrl({ redirectUri, state }) {
      const params = new URLSearchParams({
        client_id: config.spotify.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SPOTIFY_SCOPES,
        state,
      });
      return `${ACCOUNTS}/authorize?${params}`;
    },

    async exchangeCode({ code, redirectUri }) {
      const res = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      return tokens.set('spotify', {
        accessToken: res.access_token,
        expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
        refreshToken: res.refresh_token,
        authorizedAt: new Date().toISOString(),
      });
    },
  };
}
