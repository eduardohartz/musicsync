# musicsync — Design Specification

**Date:** 2026-07-20
**Status:** Approved for implementation (autonomous session; user pre-approved research → plan → build)
**Basis:** `docs/research/api-research.md` (live-verified 2026-07-20; 34/36 claims adversarially confirmed)

## 1. What it is

An open-source, self-hosted Node.js utility that performs **one-way playlist synchronization** between Spotify and TIDAL on a cron schedule. One platform is the **master** (source of truth), the other the **slave** (fully tool-owned mirror). Runs headless in Docker; all configuration via environment variables. Uses **only official APIs** (Spotify Web API dev-mode paths, TIDAL API v2 at `openapi.tidal.com/v2`) — the first sync tool to do so.

**Non-goals (v1):** two-way merge sync, liked-songs/collection sync, album/artist library sync, multiple user accounts, a web UI.

## 2. Constraints inherited from research (normative)

| ID | Constraint | Design response |
|---|---|---|
| D1 | Spotify refresh tokens hard-expire 6 months after authorization | Persist `authorized_at`; warn loudly from month 5; on `invalid_grant` fail the service into a clear "re-auth needed" state (loud logs + unhealthy healthcheck), never crash-loop |
| D2 | Spotify dev mode: user registers own app; owner needs Premium | Documented in README; no shared client ID shipped |
| D3 | Spotify playlist items readable only if user owns/collaborates | Validate master playlists at startup; actionable error otherwise |
| D4 | Spotify: no batch track GET, search limit ≤10 | ISRC hydration via `fields` on playlist-items reads; search fallback uses multiple query formulations, never deep paging |
| D5/D6 | TIDAL beta: ~1 req/s budget, possible client-ID gating | Global token-bucket throttle; backoff on 429 **and** 403 honoring `Retry-After`; README instructs smoke-testing auth first (`auth` command is the smoke test) |
| D7 | TIDAL refresh-token longevity undocumented | Always persist rotated refresh tokens; graceful re-auth path identical to Spotify's |
| D8 | TIDAL has no PRIVATE playlists (PUBLIC \| UNLISTED only) | Default slave `accessType=UNLISTED`; documented semantic gap |
| D9 | TIDAL reorder ≤20/call; `positionBefore` semantics unverified (U2) | v1 never uses reorder/`positionBefore`: append-in-order builds, clear-and-rebuild on order drift |

## 3. Architecture

Plain **ESM JavaScript**, Node ≥ 22 (Docker image: `node:24-alpine`). Runtime dependency: **`node-cron` v4 only**. HTTP via native `fetch`. Tests via built-in `node:test`.

```
src/
  index.js            entrypoint: config → auth check → cron schedule (noOverlap) → graceful shutdown
  cli.js              subcommands: (default) run service | auth [--manual] | sync-once | status
  config.js           ENV parsing + validation (zero-dep), fail-fast with actionable messages
  logger.js           tiny leveled logger (ts, level, module) — no dep
  http.js             fetch wrapper: per-host token-bucket throttle, retries, Retry-After (429 both / 403 TIDAL),
                      JSON + JSON:API bodies, typed ApiError
  tokens.js           token store: /config/tokens.json, atomic write (tmp+rename), chmod 600,
                      per-service {access_token, expires_at, refresh_token, authorized_at}
  state.js            sync state: /config/state.json — playlist pairs, track-mapping cache,
                      failure cache (retry every N runs), Spotify snapshot_ids, TIDAL lastModifiedAt,
                      unmatched report; atomic writes
  auth/
    bootstrap.js      one-time interactive auth: temporary HTTP server on http://127.0.0.1:PORT
                      (both platforms), paste-the-URL manual fallback; PKCE for TIDAL, code flow for Spotify
  platforms/
    spotify.js        adapter: auth refresh + Web API client (2026 dev-mode /items paths only)
    tidal.js          adapter: PKCE user token + client-credentials catalog token (dual-token),
                      JSON:API client, cursor pagination, Idempotency-Key on mutations
  match.js            track matcher: ISRC-primary, metadata fallback, normalization, exclusions,
                      deterministic candidate selection, manual overrides
  sync.js             sync engine: per-pair short-circuit → fetch → map → diff → chunked apply → report
healthcheck.js        Docker HEALTHCHECK probe
test/                 node:test unit tests (matcher, diff, config, chunking, http retry)
Dockerfile, compose.yml, .env.example, README.md, LICENSE (MIT)
```

### 3.1 Platform adapter interface

Both adapters implement the same contract so the sync engine is direction-agnostic (`SYNC_MASTER` picks which is which):

```js
getCurrentUser()                    → {id, country?}
listOwnPlaylists()                  → [{id, name, ...}]
getPlaylistMeta(id)                 → {id, name, changeToken}   // Spotify: snapshot_id; TIDAL: lastModifiedAt+numberOfItems
getPlaylistItems(id)                → [{platformTrackId, itemId?, isrc, title, version?, artists[], durationMs, isLocal?}]
createPlaylist({name, description}) → {id}
setPlaylistItems(id, trackIds[], currentItems[]) → void   // platform-optimal write strategy inside
findTracksByIsrc(isrc)              → [candidate]
searchTracks({title, artist, album}) → [candidate]          // capped, multiple formulations
describeAuth()                      → status for `status` cmd + re-auth warnings
```

### 3.2 Token & write strategies (inside adapters)

- **Spotify writes:** target == current → skip. Appends-only → `POST /items` in 100-chunks. Otherwise full rewrite: `PUT /items` (first ≤100, replace mode) then `POST` 100-chunks; chain returned `snapshot_id`s. Remove-by-URI is avoided entirely (dup-unsafe).
- **TIDAL writes:** target == current → skip. Appends-only → `POST relationships/items` 50-chunks (append preserves order). Otherwise clear-and-rebuild in place: `DELETE relationships/items` by `meta.itemId` in 50-chunks (re-fetched, never cached), then append 50-chunks. Playlist id never changes. Every mutation carries `Idempotency-Key` (UUID per logical operation).
- **Duplicates** in the master are preserved (both write strategies are sequence-based, not set-based).

## 4. Matching engine

Per master track, in order; first hit wins; results persisted in the mapping cache `{masterTrackId → {slaveTrackId, matchedBy: isrc|fallback|manual, isrc}}`:

1. **Manual override** from `/config/overrides.json` (`{masterTrackId: slaveTrackId}`) — the escape hatch.
2. **Mapping cache** hit.
3. **ISRC lookup** on slave platform (TIDAL: `GET /tracks?filter[isrc]=` on client-credentials token; Spotify: `GET /search?q=isrc:…&type=track`). 2+ candidates: apply exclusion rule, prefer closest duration; tie-break lexicographically smallest id (deterministic).
4. **Metadata fallback:** query formulations `album+artist` then `track+artist`; accept iff `|Δduration| < 2 s` AND normalized-title substring match AND artist-name-set overlap.
   **Hard exclusion:** reject candidate if any of {instrumental, acapella, remix} appears on exactly one side (TIDAL: check both `title` and `version`).
   **Normalization:** casefold + NFKC always; ASCII-fold only when both strings are Latin-script; strip bracket/hyphen version suffixes for the "simple" form.
5. **Unmatched:** record in failure cache (skip until `retryAfterRuns` elapse), append to unmatched report, continue — a missing match never fails a run.

Spotify `is_local` items are skipped up-front (no ISRC, not addable via API).

## 5. Sync run (per configured pair)

1. Resolve pair: master playlist id from config; slave playlist id from state (create on slave + persist if absent; name mirrored, `[musicsync]` description tag).
2. **Short-circuit:** master `changeToken` unchanged since last successful run **and** slave `changeToken` unchanged (slave untouched by hand) → skip pair.
3. Fetch master items (ordered, ISRC-hydrated in the same paged reads).
4. Map to slave track ids (§4) → target sequence (unmatched tracks omitted, reported).
5. Fetch slave items; if sequences equal → done; else apply via `setPlaylistItems`.
6. Persist per-pair state + both new changeTokens; write unmatched report `/config/unmatched.json` + log summary line (`synced=N matched=N/M unmatched=[…]`).

Runs are engine-level sequential (one pair at a time) under a global rate limiter (TIDAL bucket ~1 req/s; Spotify adaptive, both honoring `Retry-After`). `DRY_RUN=true` logs the diff without writing. Crash/interruption safety: state persists after each pair; TIDAL idempotency keys make replayed mutations safe; Spotify rewrites are self-correcting on rerun.

## 6. Configuration (ENV)

| Var | Required | Default | Meaning |
|---|---|---|---|
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | ✔ | — | User's own dev-mode app |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` | ✔ | — | User's own TIDAL app (secret used for client-credentials catalog token only; PKCE user flow is public-client) |
| `SYNC_MASTER` | ✔ | — | `spotify` \| `tidal` — source of truth |
| `SYNC_PLAYLISTS` | ✔ | — | Comma-separated master playlist ids; `master:slave` pins an existing slave playlist; bare id auto-creates the slave. `all` = every playlist owned by the master-platform user |
| `SYNC_CRON` | | `0 */6 * * *` | node-cron expression |
| `SYNC_ON_START` | | `true` | Run a sync immediately at boot |
| `SYNC_TZ` | | system | Cron timezone |
| `SPOTIFY_MARKET` | | `US` | Market for search/relinking (dev mode no longer exposes profile country) |
| `TIDAL_ACCESS_TYPE` | | `UNLISTED` | Access type for created TIDAL playlists (`PUBLIC`\|`UNLISTED`) |
| `SPOTIFY_PLAYLIST_PUBLIC` | | `false` | Visibility for created Spotify playlists |
| `CONFIG_DIR` | | `/config` | Tokens, state, overrides, reports |
| `AUTH_PORT` | | `8888` | Loopback callback port for `auth` |
| `DRY_RUN` | | `false` | Diff-only mode |
| `LOG_LEVEL` | | `info` | `debug`\|`info`\|`warn`\|`error` |
| `MATCH_RETRY_RUNS` | | `10` | Failure-cache retry cadence |

Config module validates everything at boot (enum membership, cron validity via `node-cron.validate`, id syntax) and prints every problem at once.

## 7. Auth lifecycle

- **Bootstrap (`musicsync auth`):** for each service missing a valid refresh token: print authorize URL (Spotify: code flow, scopes `playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private`, redirect `http://127.0.0.1:$AUTH_PORT/callback/spotify`; TIDAL: PKCE S256, scopes `playlists.read playlists.write user.read`, redirect `.../callback/tidal`), capture code on the temporary loopback server, exchange, persist. `--manual` fallback: user pastes the full redirected URL. In Docker: `docker compose run --rm -p 8888:8888 musicsync auth`. This doubles as the TIDAL client-gating smoke test (research U1).
- **Runtime:** access tokens refreshed proactively (60 s early). Newest returned refresh token always persisted (rotation-safe, U3/U6). TIDAL catalog token (client credentials) refreshed independently.
- **Expiry:** Spotify `authorized_at` drives warnings (weekly ≥ 150 days, every run ≥ 170). Any `invalid_grant` → service enters `AUTH_REQUIRED` state: loud error each cycle, syncs suspended, healthcheck unhealthy — never a crash-loop, never data loss.

## 8. Docker

- **Dockerfile:** `node:24-alpine`, `WORKDIR /app`, prod-only `npm ci`, `USER node`, `CMD ["node","src/index.js"]` (direct node — npm swallows SIGTERM), `HEALTHCHECK` runs `node healthcheck.js` (fails on `AUTH_REQUIRED` or stale heartbeat file).
- **compose.yml:** `init: true` (PID-1 signal handling), `env_file: .env`, volume `./config:/config`, `restart: unless-stopped`. Auth is a one-off: `docker compose run --rm -p 127.0.0.1:8888:8888 musicsync auth`.
- Graceful shutdown: SIGTERM → finish in-flight pair, persist state, `cron.shutdown()`, exit 0.

## 9. Error handling

- `ApiError` carries platform, status, code/subStatus, body; retry layer: 5xx and 429 (+TIDAL 403) with `Retry-After`/exponential backoff + jitter, max ~5 attempts; TIDAL 422 idempotency codes (`IDEMPOTENT_REQUEST_IN_PROGRESS` retry; `DUPLICATE_ITEMS`/`TOO_MANY_ITEMS` treated per-chunk as recoverable data errors, logged, run continues).
- Per-pair isolation: an error in one pair logs + marks the pair failed; remaining pairs still sync; process exit code stays 0 (service keeps running).
- Truly fatal (bad config, missing scopes, master playlist unreadable): exit at boot with actionable message.

## 10. Testing

`node:test` + `node --test`; no test deps. Coverage targets: matcher (normalization incl. CJK, exclusions, determinism), diff/write-strategy selection (skip vs append vs rewrite, chunking math incl. 100/50 caps), config validation, http retry/Retry-After/throttle behavior (mocked fetch/timers), token store atomicity, state round-trip. Adapters get thin mocked-fetch contract tests (correct paths, bodies, pagination walking, JSON:API parsing incl. `meta.itemId` capture).

## 11. Open questions carried into implementation

U1 (TIDAL client gating), U2 (`positionBefore` — designed around, unused), U4 (TIDAL loopback redirect acceptance — manual fallback exists), U5 (real rate numbers — conservative defaults + backoff), U9 (TIDAL paid-sub requirement — documented as unknown). None block implementation; all are documented in README "Limitations".
