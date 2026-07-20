# musicsync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This session:** executed inline by the planning agent (full research context), with a multi-agent adversarial review workflow as the final gate.

**Goal:** Build the open-source `musicsync` service: one-way Spotify↔TIDAL playlist sync on a cron schedule, official APIs only, Docker-deployable, ENV-configured.

**Architecture:** Direction-agnostic sync engine over two platform adapters implementing one contract; ISRC-primary matcher with persisted caches; all durable state in atomic JSON files under `/config`. See spec `docs/superpowers/specs/2026-07-20-musicsync-design.md` and research `docs/research/api-research.md` (endpoint tables §2.4/§3.4 are normative).

**Tech Stack:** Node ≥22 ESM, native `fetch`, `node-cron@^4.6` (sole runtime dep), `node:test`, `node:24-alpine` Docker.

## Global Constraints

- ESM (`"type": "module"`), Node `>=22`, zero runtime deps except `node-cron`.
- Spotify: 2026 dev-mode paths ONLY (`/playlists/{id}/items`, `POST /me/playlists`); never `/tracks` paths, never batch GETs, search `limit=10` max, page `limit=50`.
- TIDAL: `https://openapi.tidal.com/v2`, JSON:API content type `application/vnd.api+json`, cursor pagination via `links.next` to exhaustion, `Idempotency-Key` on every mutation, add/remove ≤50 per call, never use reorder/`positionBefore`.
- Rate defaults: TIDAL 1 req/s; Spotify 4 req/s; retry on 429 (+ TIDAL 403) honoring `Retry-After`, exp backoff + jitter on 5xx, max 5 attempts.
- All `/config` writes atomic (tmp + rename), tokens chmod 0600.
- A missing track match or single-pair failure never fails the run; `invalid_grant` → `AUTH_REQUIRED` state, not a crash.
- Every module gets a `createX(deps)` factory taking explicit dependencies (no module-level singletons) so tests inject mocks.

---

### Task 1: Scaffold

**Files:** Create `package.json`, `.gitignore`, `config/.gitkeep` (gitignored dir), `.editorconfig`.

- [ ] `package.json`: name `musicsync`, `"type":"module"`, `engines.node ">=22"`, `dependencies: {"node-cron":"^4.6.0"}`, scripts: `start=node src/index.js`, `auth=node src/cli.js auth`, `sync=node src/cli.js sync-once`, `test=node --test`, license MIT.
- [ ] `.gitignore`: `node_modules/`, `config/`, `.env`, `*.log`.
- [ ] `npm install` → lockfile. Commit `chore: scaffold project`.

### Task 2: logger + config

**Files:** Create `src/logger.js`, `src/config.js`; Test `test/config.test.js`, `test/logger.test.js`.

**Produces:**
- `createLogger(level) → {child(module) → {debug,info,warn,error}}`; each method `(msg, extra?)` prints `2026-07-20T…Z LEVEL [module] msg {extra json}` to stdout (warn/error → stderr); levels gate output.
- `loadConfig(env) → Config`; throws `ConfigError` whose `message` lists **every** problem (one per line).
- `Config` shape (used by all later tasks):
  ```js
  { spotify: {clientId, clientSecret, market, playlistPublic},
    tidal:   {clientId, clientSecret, accessType},          // accessType 'PUBLIC'|'UNLISTED'
    sync:    {master, /* 'spotify'|'tidal' */ slave, pairs, /* [{masterId, slaveId|null}] or 'all' */
              cron, onStart, tz, dryRun, matchRetryRuns},
    configDir, authPort, logLevel }
  ```
- Validation rules (each produces a named error line): required vars present; `SYNC_MASTER ∈ {spotify,tidal}`; `SYNC_PLAYLISTS` = `all` or comma list of `id` / `masterId:slaveId` (ids non-empty, no whitespace); `SYNC_CRON` valid per `nodeCron.validate`; booleans parsed from `true/false/1/0`; `AUTH_PORT` integer 1–65535; `LOG_LEVEL ∈ {debug,info,warn,error}`; `TIDAL_ACCESS_TYPE ∈ {PUBLIC,UNLISTED}`. Defaults per spec §6.

- [ ] Tests first: valid full env parses (incl. pair syntax `abc:def-123`); missing vars → all names in one error; each enum violation reported; defaults applied. Run (fail) → implement → run (pass) → commit `feat: config validation and logger`.

### Task 3: token + state stores

**Files:** Create `src/store.js` (shared atomic JSON helpers), `src/tokens.js`, `src/state.js`; Test `test/stores.test.js`.

**Produces:**
- `store.js`: `readJson(path, fallback)`, `writeJsonAtomic(path, data, {mode})` (tmp file in same dir + `rename`, optional chmod).
- `createTokenStore(configDir)`: `get(service) → {accessToken, expiresAt, refreshToken, authorizedAt} | null`, `set(service, tokens)` (merges; file `tokens.json` mode 0600), `clear(service)`.
- `createStateStore(configDir)`: `state.json` with shape
  ```js
  { runCount: 0,
    pairs: { [masterPlaylistId]: {slavePlaylistId, masterChangeToken, slaveChangeToken, lastSyncedAt} },
    mappings: { [`${masterPlatform}:${trackId}`]: {slaveTrackId, matchedBy, isrc} },
    failures: { [`${masterPlatform}:${trackId}`]: {reason, failedAtRun, track: {title, artists}} } }
  ```
  API: `load()`, `save()`, direct `.data` access, `writeUnmatchedReport(entries)` → `unmatched.json`.

- [ ] Tests: round-trip, atomicity (no partial file on simulated crash — write then read in loop), 0600 mode on tokens, fallback on missing/corrupt file (corrupt → backed up as `.corrupt-<ts>`, fresh default returned, warning logged). Commit `feat: atomic token and state stores`.

### Task 4: http client

**Files:** Create `src/http.js`; Test `test/http.test.js`.

**Produces:**
- `class ApiError extends Error { platform; status; code; body; retryAfter }`
- `createHttpClient({platform, rps, burst = rps, retryOn403 = false, logger, fetchImpl = fetch, sleep})` → `request(url, {method='GET', headers, json, form, auth, expectStatus, maxAttempts=5})`:
  - token-bucket throttle (rps sustained, burst cap) applied before every attempt;
  - `auth` is `async () => 'Bearer …'` (or Basic string) evaluated per attempt;
  - `json` → JSON body + given `Content-Type` (default `application/json`); `form` → urlencoded;
  - retry: 429 always, 403 if `retryOn403`, using `Retry-After` seconds (fallback backoff); 5xx + network errors with `min(2^attempt, 30)s + jitter`; all others throw `ApiError` immediately;
  - 204/empty → `null`, else parsed JSON; `expectStatus` array asserts.
  - Injected `sleep`/`fetchImpl` so tests run with fake timers/fetch.

- [ ] Tests: Retry-After honored (records sleep durations), 403 retried only when flagged, throttle spacing ≥ 1/rps, non-retryable 400 throws with body, success path parses JSON, 5 attempts then throws. Commit `feat: throttled retrying http client`.

### Task 5: Spotify adapter

**Files:** Create `src/platforms/spotify.js`; Test `test/spotify.test.js`.

**Consumes:** Config, token store, `createHttpClient`, logger.
**Produces:** `createSpotifyAdapter({config, tokens, logger, fetchImpl?, sleep?})` implementing the adapter contract (spec §3.1):
`platform='spotify'`, `getCurrentUser`, `listOwnPlaylists`, `getPlaylistMeta` (changeToken = `snapshot_id`), `getPlaylistItems`, `createPlaylist`, `setPlaylistItems(id, trackIds, currentItems)`, `findTracksByIsrc`, `searchTracks`, `describeAuth`, plus auth helpers `buildAuthorizeUrl({redirectUri, state})`, `exchangeCode({code, redirectUri})`, `ensureAccessToken()`.

Key request shapes (research §2.4 — copy exactly):
- refresh: `POST https://accounts.spotify.com/api/token`, Basic `clientId:clientSecret`, form `grant_type=refresh_token&refresh_token=…`; persist returned `refresh_token` when present; `invalid_grant` → throw `AuthRequiredError` (exported).
- reads: `GET /me`; `GET /me/playlists?limit=50&offset=…` until `next` null; `GET /playlists/{id}?fields=id,name,snapshot_id`; `GET /playlists/{id}/items?limit=50&offset=…&fields=next,items(is_local,item(id,name,duration_ms,artists(name),external_ids(isrc)))` — parse entry key `item ?? track` defensively; map → `{id, isrc, title, artists:[names], durationMs, isLocal}`.
- writes: create `POST /me/playlists {name, public, description}`; `setPlaylistItems`: strategy from `computeWriteStrategy` (Task 8): skip / append (`POST /playlists/{id}/items {uris}` 100-chunks) / rewrite (`PUT {uris: first ≤100}` then `POST` 100-chunks). URIs are `spotify:track:${id}`.
- search: `findTracksByIsrc` → `GET /search?q=isrc:${isrc}&type=track&limit=10&market=${market}`; `searchTracks({title, artist, album})` → up to two queries (`album:… artist:…` then `track:… artist:…`), each `limit=10`, results normalized to candidate shape `{id, isrc, title, version: null, artists, durationMs}`.
- `describeAuth()` → `{authorized, authorizedAt, daysLeft: 180 − daysSince(authorizedAt), warn: daysLeft ≤ 30}`.

- [ ] Mocked-fetch contract tests: pagination walks `next`; fields param present; `item ?? track` fallback; chunking math (250 tracks → PUT 100 + POST 100 + POST 50); refresh persists rotated token; `invalid_grant` → `AuthRequiredError`. Commit `feat: spotify adapter`.

### Task 6: TIDAL adapter

**Files:** Create `src/platforms/tidal.js`; Test `test/tidal.test.js`.

**Produces:** `createTidalAdapter({config, tokens, logger, fetchImpl?, sleep?})`, same contract. Internals:
- Dual token: user PKCE token (`tokens.get('tidal')`) for playlist ops; client-credentials token (`tokens.get('tidal-cc')`, auto-fetched `POST https://auth.tidal.com/v1/oauth2/token` Basic + `grant_type=client_credentials`) for `/tracks` + `/searchResults`.
- PKCE helpers exported: `generatePkce() → {verifier, challenge}` (S256, `crypto`), `buildAuthorizeUrl({redirectUri, state, challenge})` → `https://login.tidal.com/authorize?...scope=playlists.read+playlists.write+user.read`, `exchangeCode({code, redirectUri, verifier})` (no secret), refresh `grant_type=refresh_token&client_id&refresh_token`.
- Headers: `Accept: application/vnd.api+json`; mutations also `Content-Type: application/vnd.api+json` and `Idempotency-Key: crypto.randomUUID()` per chunk. `countryCode` (from `/users/me` `country`, cached) on catalog reads.
- Reads: `GET /users/me`; `GET /playlists?filter[owners.id]=me` (cursor walk); `getPlaylistMeta` → `GET /playlists/{id}` changeToken = `${lastModifiedAt}|${numberOfItems}`; `getPlaylistItems` → `GET /playlists/{id}/relationships/items?include=items,items.artists` cursor walk; map data[] entries `{id, type, meta:{itemId}}` + `included` track resources → `{id, itemId, isrc, title, version, artists, durationMs: parseIsoDuration(attributes.duration), isLocal:false}`; skip `type==='videos'`.
- Writes: create `POST /playlists` JSON:API body `{data:{type:'playlists', attributes:{name, description, accessType}}}`; `setPlaylistItems`: skip / append (`POST /playlists/{id}/relationships/items {data:[{id,type:'tracks'}]}` 50-chunks) / clear-and-rebuild (re-fetch items → `DELETE …/relationships/items {data:[{id, type:'tracks', meta:{itemId}}]}` 50-chunks → append all 50-chunks). Handle 422 codes: `IDEMPOTENT_REQUEST_IN_PROGRESS` → retry after 2 s (max 3); duplicate/too-many → log warn, continue.
- `findTracksByIsrc` → `GET /tracks?filter[isrc]=…&countryCode=…&include=artists`; `searchTracks` → `GET /searchResults/{encodeURIComponent(q)}?include=tracks,tracks.artists&countryCode=…`, same two query formulations, candidates `{id, isrc, title, version, artists, durationMs}`.
- `parseIsoDuration('PT3M21S') → 201000` exported.

- [ ] Tests: cursor pagination follows `links.next` until absent; `meta.itemId` captured; JSON:API bodies exact (deep-equal against fixtures); Idempotency-Key present & unique per chunk; dual-token routing (catalog calls use cc token); `parseIsoDuration` cases (`PT1H2M3S`, `PT45S`, `PT3M`). Commit `feat: tidal adapter`.

### Task 7: auth bootstrap + CLI

**Files:** Create `src/auth/bootstrap.js`, `src/cli.js`; Test `test/bootstrap.test.js`.

**Consumes:** adapters' `buildAuthorizeUrl`/`exchangeCode`/`generatePkce`, token store.
**Produces:** `runAuthBootstrap({config, tokens, adapters, manual, logger, openStdin?})`:
- Determines services needing auth (no refresh token, or `--force`).
- Serve mode: `node:http` server on `0.0.0.0:${authPort}` handling `GET /callback/spotify` + `/callback/tidal`; prints authorize URLs (redirect URIs `http://127.0.0.1:${authPort}/callback/<svc>`); validates `state` (random per service); on code → exchange → `tokens.set(svc, {…, authorizedAt: now})` → HTML "done, close tab"; exits when all done or 10 min timeout.
- Manual mode (`--manual`): prints URLs, reads pasted redirected URL(s) from stdin, extracts `code`/`state`, same exchange.
- `cli.js`: argv dispatch — `auth [--manual] [--force]`, `sync-once`, `status` (prints `describeAuth` for both + state summary: pairs, last sync, unmatched count), default → start service (delegates to `src/index.js` `main()`).

- [ ] Tests (no real server ports where avoidable): callback URL parsing (code/state extraction, state mismatch → rejected), redirect URI construction, service-selection logic honors existing tokens/`--force`. Commit `feat: interactive auth bootstrap and CLI`.

### Task 8: matcher + write strategy

**Files:** Create `src/match.js`, `src/diff.js`; Test `test/match.test.js`, `test/diff.test.js`.

**Produces (`diff.js`):**
- `computeWriteStrategy(targetIds, currentIds) → {type:'skip'} | {type:'append', toAppend} | {type:'rewrite'}` — skip iff arrays equal; append iff `current` is a strict prefix of `target`; else rewrite. Pure; used by both adapters.
- `chunk(arr, n)`.

**Produces (`match.js`):** `createMatcher({slave, state, overrides, logger, retryRuns})` → `async matchTrack(masterPlatform, track) → {slaveTrackId, matchedBy} | {unmatched, reason}` implementing spec §4 order (override → cache → ISRC → fallback → failure-cache write). Exported pure helpers with exact semantics:
```js
normalizeTitle(s)      // casefold + NFKC; ASCII-fold via NFD strip only if isLatinScript(s); trim
simpleTitle(s)         // normalizeTitle + strip trailing "(...)"/"[...]"/" - ..." suffix
isLatinScript(s)       // true iff every letter cp < 0x0250
versionConflict(a, b)  // a,b: {title, version} — true iff any of ['instrumental','acapella','remix']
                       // present (title+version, normalized) on exactly one side
fallbackMatches(master, cand) // |Δms| < 2000 && (simpleTitle inclusion either direction)
                              // && artistOverlap(normalized name sets) && !versionConflict
pickCandidate(master, cands)  // filter versionConflict; sort by (|Δduration|, id) → first  (deterministic)
```
Failure-cache: on unmatched, store `failedAtRun = state.data.runCount`; skip retry until `runCount − failedAtRun ≥ retryRuns`.

- [ ] Tests: CJK title survives normalization (no NFD deletion — regression from prior-art bug); `Song (Remastered 2011)` simpleTitle → `song`; remix-on-one-side rejected, remix-on-both accepted; duration 1999 ms accepted / 2000 rejected; determinism (shuffled candidates → same pick); strategy: equal→skip, prefix→append, reorder→rewrite, shrink→rewrite; matcher consults override before cache before ISRC (mock slave adapter records calls); failure-cache honors retryRuns. Commit `feat: track matcher and write strategy`.

### Task 9: sync engine

**Files:** Create `src/sync.js`; Test `test/sync.test.js`.

**Consumes:** two adapters (as `master`/`slave` roles), state store, matcher, config.
**Produces:** `createSyncEngine({config, master, slave, state, matcher, logger})` → `async runSync() → {pairs: [{masterId, slaveId, status: 'skipped'|'synced'|'failed', matched, unmatched, written}], unmatchedTotal}` implementing spec §5:
1. Resolve pair list (`all` → `master.listOwnPlaylists()`; else config pairs). Increment `runCount`.
2. Per pair (sequential, try/catch → `failed` status, continue): ensure slave playlist (create with mirrored name + description `Synced from <master> by musicsync — do not edit; changes are overwritten.`, persist); short-circuit when both changeTokens match state **and** mapping complete; fetch master items (drop `isLocal`); match all → target sequence; `dryRun` → log diff only; else `slave.setPlaylistItems`; refresh both changeTokens into state; save state after each pair.
3. Aggregate unmatched entries → `state.writeUnmatchedReport` + one summary log line per pair.

- [ ] Tests with stub adapters/matcher: short-circuit skips fetch; unmatched tracks omitted from target but reported; one pair throwing doesn't stop the next; dry-run performs no writes; state persisted between pairs; auto-create persists new slave id. Commit `feat: sync engine`.

### Task 10: entrypoint, scheduler, healthcheck

**Files:** Create `src/index.js`, `healthcheck.js`; Test `test/health.test.js` (heartbeat logic only).

**Produces:** `main()` in `index.js`: load config → build logger/stores/adapters/matcher/engine → verify tokens exist (else log `Run "musicsync auth" first` and exit 1) → if `SYNC_ON_START` run once → `cron.schedule(config.sync.cron, run, {timezone: config.sync.tz, noOverlap: true, name: 'musicsync'})` → SIGTERM/SIGINT: stop task, await in-flight run, save state, exit 0. Each run wrapped: on success write heartbeat `/config/health.json` `{status:'OK', lastOkAt, nextDueMs}`; on `AuthRequiredError` write `{status:'AUTH_REQUIRED'}` and keep service alive (skips future runs until tokens change); Spotify `describeAuth().warn` → weekly warning log. `healthcheck.js`: exit 1 if health file missing/`AUTH_REQUIRED`/`lastOkAt` older than `max(2×nextDueMs, 26h)`; else 0.

- [ ] Test heartbeat-evaluation function (exported pure). Manual smoke: `node src/index.js` with bad env → aggregated config error; `node src/cli.js status`. Commit `feat: service entrypoint with cron and healthcheck`.

### Task 11: Docker + docs + license

**Files:** Create `Dockerfile`, `compose.yml`, `.env.example`, `README.md`, `LICENSE`, `docs/` cross-links.

- [ ] Dockerfile: `FROM node:24-alpine` → `WORKDIR /app` → copy manifests → `npm ci --omit=dev` → copy src → `ENV NODE_ENV=production CONFIG_DIR=/config` → `USER node` → `HEALTHCHECK --interval=5m --timeout=10s CMD node healthcheck.js` → `ENTRYPOINT ["node","src/cli.js"]` (default CMD = service; `docker compose run musicsync auth` works).
- [ ] compose.yml: service `musicsync`, `build: .`, `init: true`, `env_file: .env`, `volumes: ["./config:/config"]`, `restart: unless-stopped`.
- [ ] `.env.example`: every var from spec §6 with comments.
- [ ] README: what/why (first official-API-only sync tool), quickstart (register Spotify app — Premium owner, redirect `http://127.0.0.1:8888/callback/spotify`; register TIDAL app — redirect `.../callback/tidal`; compose up), auth walkthrough incl. remote-server `--manual`, full ENV table, how matching works, **Limitations** (Spotify 6-month re-auth D1, Premium D2, own-playlists-only D3, TIDAL beta/rate D5-D7, UNLISTED-not-private D8, slave overwritten), FAQ, contributing, MIT.
- [ ] `docker build .` succeeds. Commit `feat: docker packaging and documentation`.

### Task 12: review gate

- [ ] Full `npm test` green.
- [ ] Launch adversarial review workflow (finders: research-fidelity vs `docs/research/api-research.md`, correctness/edge-cases, security/token-handling, docs-accuracy; each finding verified by refuters; majority-confirmed findings fixed inline; re-test; final commit).

## Self-Review (done)

- **Spec coverage:** §2 constraints → Global Constraints + Tasks 5/6/10; §3 files → Tasks 1–10 (store.js added as shared helper — spec's tokens/state split preserved); §4 → Task 8; §5 → Task 9; §6 → Task 2; §7 → Tasks 5–7; §8 → Tasks 10–11; §9 → Tasks 4–6, 9–10; §10 → per-task tests; §11 → README Limitations (Task 11).
- **Type consistency:** adapter contract identical in Tasks 5/6 and consumed in 8/9 (`matchTrack(masterPlatform, track)`, `setPlaylistItems(id, trackIds, currentItems)`); candidate/track shapes unified (`{id, itemId?, isrc, title, version, artists, durationMs, isLocal}`); `computeWriteStrategy` shared by both adapters.
- **Placeholders:** none — every validation rule, request shape, strategy rule, and test case is enumerated above or normatively referenced to research §2.4/§3.4 tables.
