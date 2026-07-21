import { AuthRequiredError } from './http.js';

const VERSION_MARKERS = ['instrumental', 'acapella', 'remix'];
const DURATION_TOLERANCE_MS = 2000;

/**
 * Canonical ISRC: 12 alphanumerics, uppercase. Source platforms sometimes
 * deliver lowercase (TIDAL's filter[isrc] rejects those with a 400) or
 * dash-separated forms; anything that doesn't normalize cleanly is treated
 * as absent so matching falls back to metadata search.
 */
export function normalizeIsrc(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return /^[A-Z0-9]{12}$/.test(cleaned) ? cleaned : null;
}

/** True iff every letter code point is below 0x0250 (basic Latin + extensions). */
export function isLatinScript(s) {
  for (const ch of s ?? '') {
    if (/\p{L}/u.test(ch) && ch.codePointAt(0) >= 0x0250) return false;
  }
  return true;
}

/**
 * Script-aware normalization: casefold + NFKC always; ASCII-fold (NFD strip)
 * only when the string is Latin — naive NFD folding deletes CJK entirely
 * (a real bug in prior-art matchers).
 */
export function normalizeTitle(s) {
  let out = (s ?? '').normalize('NFKC').toLowerCase().trim();
  if (isLatinScript(out)) out = out.normalize('NFD').replace(/\p{M}/gu, '');
  return out.replace(/\s+/g, ' ');
}

/** Normalized title with bracketed and trailing "- …" version suffixes stripped. */
export function simpleTitle(s) {
  const stripped = (s ?? '')
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .trim();
  return normalizeTitle(stripped || s);
}

function markerSet(track) {
  const haystack = normalizeTitle(`${track.title ?? ''} ${track.version ?? ''}`);
  return new Set(VERSION_MARKERS.filter((m) => haystack.includes(m)));
}

/**
 * Hard exclusion: a marker (instrumental/acapella/remix) present on exactly
 * one side means a different recording, whatever the other signals say.
 * TIDAL keeps version info in a separate `version` field — both are checked.
 */
export function versionConflict(a, b) {
  const ma = markerSet(a);
  const mb = markerSet(b);
  return VERSION_MARKERS.some((m) => ma.has(m) !== mb.has(m));
}

export function artistOverlap(artistsA, artistsB) {
  const setA = new Set((artistsA ?? []).map(normalizeTitle));
  return (artistsB ?? []).some((name) => setA.has(normalizeTitle(name)));
}

/** Metadata fallback rule (proven in prior art): duration ±2s AND title inclusion AND artist overlap. */
export function fallbackMatches(master, candidate) {
  if (versionConflict(master, candidate)) return false;
  if (master.durationMs == null || candidate.durationMs == null) return false;
  if (Math.abs(master.durationMs - candidate.durationMs) >= DURATION_TOLERANCE_MS) return false;
  const mt = simpleTitle(master.title);
  const ct = simpleTitle(candidate.title);
  if (!mt || !ct || !(mt.includes(ct) || ct.includes(mt))) return false;
  return artistOverlap(master.artists, candidate.artists);
}

function closestByDuration(master, candidates) {
  const delta = (c) => (c.durationMs == null || master.durationMs == null
    ? Number.MAX_SAFE_INTEGER
    : Math.abs(c.durationMs - master.durationMs));
  return [...candidates].sort((x, y) => delta(x) - delta(y) || String(x.id).localeCompare(String(y.id)))[0] ?? null;
}

/**
 * Deterministic candidate selection so reruns are stable: filter version
 * conflicts, then closest duration, then lexicographically smallest id.
 */
export function pickCandidate(master, candidates) {
  const viable = (candidates ?? []).filter((c) => !versionConflict(master, c));
  return closestByDuration(master, viable);
}

/**
 * Matching pipeline per track, direction-explicit:
 * manual override → mapping cache → ISRC lookup → metadata fallback → failure cache.
 * Every successful match is recorded in BOTH directions so two-way sync gets
 * cache hits regardless of which platform a track was first seen on.
 * A miss never throws; it returns {unmatched: true, reason}.
 */
export function createMatcher({ adapters, state, overrides = {}, logger, retryRuns = 10 }) {
  const log = logger.child('match');

  return {
    async matchTrack(track, fromPlatform, toPlatform) {
      const key = `${fromPlatform}:${track.id}`;

      const overrideId = overrides[key] ?? overrides[track.id];
      if (overrideId) return { matchedId: overrideId, matchedBy: 'manual' };

      const cached = state.data.mappings[key];
      if (cached) return { matchedId: cached.matchedId, matchedBy: cached.matchedBy };

      const failure = state.data.failures[key];
      if (failure && state.data.runCount - failure.failedAtRun < retryRuns) {
        return { unmatched: true, reason: failure.reason, fromFailureCache: true };
      }

      const target = adapters[toPlatform];
      const isrc = normalizeIsrc(track.isrc);
      const record = (matchedId, matchedBy, matchedIsrc) => {
        state.data.mappings[key] = { matchedId, matchedBy, isrc: isrc ?? null };
        const reverseKey = `${toPlatform}:${matchedId}`;
        state.data.mappings[reverseKey] ??= { matchedId: track.id, matchedBy, isrc: normalizeIsrc(matchedIsrc) ?? isrc };
        delete state.data.failures[key];
        log.debug('matched', { key, matchedId, matchedBy });
        return { matchedId, matchedBy };
      };

      // One bad lookup must cost one track, not the whole playlist: catch
      // per-track API errors (a malformed ISRC in the source catalog gets a
      // 400 from TIDAL), continue down the pipeline, and keep transient
      // failures OUT of the failure cache so the next run retries them.
      let lookupFailed = false;
      const guard = async (what, fn) => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof AuthRequiredError) throw err;
          lookupFailed = true;
          log.warn(`${what} lookup failed for track, continuing`, { key, error: String(err.message ?? err) });
          return null;
        }
      };

      if (isrc) {
        const candidates = await guard('isrc', () => target.findTracksByIsrc(isrc));
        // A lone ISRC hit is authoritative — same recording by definition,
        // even when the platforms label versions differently (TIDAL keeps
        // "Remix" in a separate field). Version guards only arbitrate
        // between multiple pressings; if they exclude everything, fall back
        // to closest-duration among the (same-recording) candidates.
        if (candidates?.length === 1) return record(candidates[0].id, 'isrc', candidates[0].isrc);
        if (candidates?.length > 1) {
          const pick = pickCandidate(track, candidates) ?? closestByDuration(track, candidates);
          if (pick) return record(pick.id, 'isrc', pick.isrc);
        }
      }

      const searched = await guard('search', () => target.searchTracks({
        title: track.title,
        artist: track.artists?.[0],
        album: track.album,
      }));
      if (searched) {
        const viable = searched.filter((c) => fallbackMatches(track, c));
        const pick = pickCandidate(track, viable);
        if (pick) return record(pick.id, 'fallback', pick.isrc);
      }

      if (lookupFailed) {
        log.info('unmatched track (lookup error, will retry next run)', { key, title: track.title });
        return { unmatched: true, reason: 'lookup-failed', transient: true };
      }

      const reason = isrc ? 'no-match-on-target' : 'no-usable-isrc-and-no-metadata-match';
      state.data.failures[key] = {
        reason,
        failedAtRun: state.data.runCount,
        track: { title: track.title, artists: track.artists },
      };
      log.info('unmatched track', { key, title: track.title, reason });
      return { unmatched: true, reason };
    },
  };
}
