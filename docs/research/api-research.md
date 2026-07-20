# musicsync — API Research Report (Spotify ↔ TIDAL)

**Date:** 2026-07-20
**Method:** Six researcher agents investigated the live Spotify and TIDAL developer platforms; every critical claim (36 total) passed through adversarial verification against primary sources. Verdicts: **34 confirmed** (several with corrections), **2 refuted**, **0 unclear**. Refuted verdicts override the original research; all corrections are folded into the sections below and enumerated in §7.

---

## 1. Feasibility Verdict

**The project is feasible entirely on official APIs.** Both platforms expose everything a one-way (master→slave) playlist sync needs: authenticated playlist read/write, track lookup by ISRC, and text search. Notably, the official TIDAL v2 API now has full playlist CRUD — every inspected prior-art tool predates this and rides the unofficial `api.tidal.com/v1`; musicsync can be the first official-API-only implementation.

**No hard blockers.** Degraded capabilities that shape the design:

| # | Constraint | Impact |
|---|---|---|
| D1 | **Spotify refresh tokens hard-expire 6 months after user authorization** (enforced for all apps as of 2026-07-20; refreshing does *not* extend it) | True set-and-forget is impossible. Must build a re-auth UX (alert + temporary loopback auth server) at least twice a year. |
| D2 | **Spotify Development Mode** (the only tier attainable): owner needs active **Premium**, 1 Client ID per developer, max 5 authorized users | Every self-hoster registers their own Spotify app; shipping a shared Client ID is not viable. Free-tier owners cannot use the tool. |
| D3 | Spotify dev mode: **playlist items readable only for playlists the user owns or collaborates on** (403 otherwise) | A followed/editorial/another user's Spotify playlist cannot be a master source. |
| D4 | Spotify dev mode: **batch endpoints removed** (`GET /tracks?ids=` etc.), **search capped at limit=10** (default 5) | Request counts multiply against unpublished rate limits; matching must lean on the `fields` parameter and ISRC filters, not deep search paging. |
| D5 | **TIDAL platform is Beta**: rate limits undocumented (historically ≈1 search/5 s; per-Client-ID), quota increases not accepted (staff, Feb 2025) | Budget ~1 req/s with `Retry-After` backoff; expect spec churn (pin to OAS v1.10.66). |
| D6 | **TIDAL client-ID gating cannot be ruled out** (unanswered reports: "not approved for Open API access" May 2026; 401 subStatus 6004 "Client does not have required access tier" Nov 2025) | Open risk — smoke-test a fresh app's user-scope authorize flow before committing (§7-U1). |
| D7 | TIDAL refresh-token lifetime is undocumented (SDK README implies "very long time") | Unattended refresh is plausible but unguaranteed; persist rotated refresh tokens and handle re-auth gracefully. |
| D8 | TIDAL playlists have no PRIVATE access type — only `PUBLIC` \| `UNLISTED` | Map Spotify-private → TIDAL `UNLISTED` and document the semantic gap. |
| D9 | TIDAL reorder = 20 items/request; ordered inserts use `positionBefore` | Order maintenance is call-expensive; prefer append-in-order on create and targeted delete+insert on drift. |

---

## 2. Spotify Web API

### 2.1 App setup

- Register in the **Developer Dashboard** (name, description, redirect URI, accept ToS). Client ID + secret issued free.
- Since **Feb 11, 2026** ("Update on Developer Access and Platform Security", blog 2026-02-06): Development Mode requires the **owner to hold an active Spotify Premium account** (app stops if it lapses), **one Development Mode Client ID per developer**, **max 5 authorized users per app** (down from 25). Verifier correction: effective date is precisely Feb 11, 2026 (researcher's "Feb/Mar" hedge unnecessary); the one-Client-ID rule appears in the blog but not yet on the quota-modes doc page.
- Dev mode is explicitly sanctioned for "learning, experimentation, and personal projects for non-commercial use" and for "managing data in a single Spotify account" — a single-user sync tool fits, with no time limit stated.
- **Extended Quota Mode is unattainable**: since May 15, 2025, applications are accepted only from legally registered organizations operating a launched service with ≥250k MAU. Design for dev mode permanently.
- **Redirect URIs**: HTTPS required, except explicit loopback IP literals `http://127.0.0.1:PORT` / `http://[::1]:PORT` (HTTP OK). The hostname `localhost` is **banned**. A loopback URI may be registered without a port and given a dynamic port at authorization time. Verifier correction: Apr 9, 2025 applied to new apps; grandfathered apps lost implicit grant / HTTP redirects / localhost on **Nov 27, 2025** — as of today the rules bind all apps. (Custom URI schemes remain allowed but are irrelevant here.)

### 2.2 Auth flow for headless use

- **Authorization Code flow** (PKCE optional for a confidential server holding the secret; the Nov 2025 OAuth migration did not mandate PKCE for confidential apps). **Client Credentials cannot be used**: it returns no refresh token and cannot access any user data/playlists.
- Bootstrap: one interactive consent in a browser — `GET https://accounts.spotify.com/authorize` with loopback redirect → exchange code at `POST https://accounts.spotify.com/api/token` (HTTP Basic `client_id:client_secret`, form-encoded) → persist tokens into the container volume.
- Access tokens: TTL **3600 s**.
- **Refresh-token lifecycle (critical):** refresh tokens **expire 6 months after user authorization** (announced 2026-06-18; new apps immediately, existing apps from **2026-07-20** — i.e., live now). Refreshing does **not** reset the clock. Expired/revoked → `400 {"error":"invalid_grant"}` → must re-run interactive consent (which starts a new 6-month lifetime). Only Client Credentials tokens are exempt (useless here). Refresh responses **may or may not** include a new `refresh_token`; rotation semantics are undocumented — always persist the newest returned value, keep the old one when absent.

### 2.3 Scopes

`playlist-read-private`, `playlist-read-collaborative`, `playlist-modify-public`, `playlist-modify-private`. (All four confirmed to exist with the stated purposes.)

### 2.4 Endpoint table (dev-mode paths, post-Feb-2026 — use these unconditionally)

Base: `https://api.spotify.com/v1`. All playlist `/tracks` verbs were renamed to `/items`; response container `tracks`→`items`, entry key `track`→`item` (parse `item ?? track` defensively during transition).

| Method | Path | Purpose | Caps / pagination / notes |
|---|---|---|---|
| GET | `/me` | Current user profile → user id for ownership checks | `country`, `email`, `product` deprecated/removed for dev mode — take market from ENV, not profile. New immutable `account_id` available. |
| GET | `/me/playlists` | List current user's playlists | `limit` ≤ 50 (default 20), `offset` ≤ 100,000; paginate via `next`/`total`. Fields: `id`, `name`, `owner.id`, `snapshot_id`, `public`, `collaborative`. |
| GET | `/playlists/{id}` | Playlist metadata + `snapshot_id` (cheap change detection) | `market`, `fields`, `additional_types`. Non-owned playlists: metadata only, no items. |
| GET | `/playlists/{id}/items` | Read playlist items (replaces `/tracks`) | `limit` ≤ 50 (default 20); **403 unless user owns/collaborates**. Entry: `added_at`, `is_local`, `item` (track). `fields` supports nested selection incl. `external_ids` — primary path for ISRC hydration. |
| POST | `/me/playlists` | Create playlist (replaces removed `POST /users/{id}/playlists`) | Body: `name` (required), `public` (default **true** — set explicitly), `collaborative` (requires `public=false`), `description`. 201 → full playlist with `id`, `snapshot_id`. Verifier note: this path is not new; it was already available and is now the only creation path. |
| POST | `/playlists/{id}/items` | Add tracks | ≤ **100 URIs**/request (body `{"uris":[...],"position":n}`; omit `position` to append). 201 → `{snapshot_id}`. |
| DELETE | `/playlists/{id}/items` | Remove tracks | ≤ **100 objects**; body key is **`items`** (`{"items":[{"uri":"spotify:track:..."}],"snapshot_id":"..."}`); optional `snapshot_id` guards concurrent edits. 200 → `{snapshot_id}`. |
| PUT | `/playlists/{id}/items` | **Replace** (`uris`, ≤ 100 — overwrites all; usable to clear/set) or **reorder** (`range_start`, `insert_before`, `range_length`, `snapshot_id`) | Two modes **mutually exclusive** per request. 200 → `{snapshot_id}`. |
| PATCH | `/playlists/{id}` | Change name/description/visibility | PATCH per Feb 2026 migration guide (historically PUT). |
| GET | `/search` | Track matching (`q=isrc:XXXX&type=track`, or `track:`/`artist:`/`album:` filters) | **`limit` ≤ 10 (default 5)** for all dev-mode apps; `offset` ≤ 1000. `isrc` filter confirmed live July 2026. |
| GET | `/tracks/{id}` | Single-track metadata / ISRC verification | `market` triggers relinking (`is_playable`). **Batch `GET /tracks?ids=` removed** — one request per track. `external_ids.isrc` **available** (Feb 2026 removal reverted Mar 2026). `popularity`, `available_markets`, `linked_from` removed — do not rely on `linked_from` for relinked-track resolution. |

### 2.5 Rate limits

No numeric caps published for either quota mode. Rolling **30-second window**; dev-mode limits are lower than extended. 429 responses carry `Retry-After` (seconds). Implement Retry-After-driven backoff; batch-endpoint removal multiplies request counts, so cap per-run request budgets on large playlists.

### 2.6 Restrictions relevant to new 2026 apps (summary)

Renamed `/items` paths; removed: batch gets, browse endpoints, `GET /users/{id}`, `GET /users/{id}/playlists` (no replacement — reading arbitrary users' playlists is gone entirely); search limit 10/5; playlist items owner/collaborator-only; track fields `popularity`/`available_markets`/`linked_from` removed, `external_ids` **reverted (kept)**; Premium owner, 1 Client ID, 5 users. Extended-quota apps are exempt from all of it.

**Researcher/verifier tension (enforcement timing):** the spotify-auth and spotify-endpoints researchers reported that endpoint restrictions for *existing* (pre-2026) apps were postponed after community feedback; the verifier of the matching-prior-art claim found the migration guide's Mar 9, 2026 date confirmed by the changelog **and** by third-party bug reports of 403s on old paths after Mar 9 — i.e., the migration shipped for existing apps too. Resolution: moot for musicsync (any new app gets the restrictions from day one); target the new paths unconditionally.

---

## 3. TIDAL API v2

### 3.1 App setup

- Dashboard at `developer.tidal.com/dashboard`; log in with a **regular free TIDAL account**; accept Guidelines. Client ID + Client Secret auto-generated per app; **max 10 apps** per account. No fee.
- Scopes are enabled per-app in Settings ("Only enable the scopes your application needs") — self-service on paper, **but** see D6/§7-U1: Developer Terms v3.0 (Clause IV) document a formal "Production Mode" approval (source-code review, quota extension), and two unanswered community reports show client IDs rejected for Open API access / access tier. Staff stated (Feb 3, 2025) the platform is **Beta** and quota-increase requests are not accepted; no newer statement found. Assume "in development" quotas indefinitely.
- No requirement found that the user hold a paid TIDAL subscription for playlist read/write (undocumented either way).

### 3.2 Auth flow for headless use

- OAuth 2.1. Authorize: `https://login.tidal.com/authorize`; token: `https://auth.tidal.com/v1/oauth2/token`. Three flows: **Client Credentials** (Basic auth), **Authorization Code + PKCE** (S256 **mandatory**; public client — no secret at exchange or refresh), **Refresh Token** (`client_id` + `refresh_token`).
- **Device flow exists but is TIDAL-internal only** ("Only available for TIDAL internally developed applications for now") — do not build on it.
- Bootstrap identical in shape to Spotify: one interactive PKCE consent via a configured redirect URI, then unattended refresh. Redirect-URI rules are not publicly documented; `http://localhost:8000/auth/callback` shown working in a Nov 2024 maintainer-confirmed thread (anecdotal — verify at app creation; the SDK's "secure context / valid https" note applies to its browser SPA usage).
- **Tokens:** access tokens show `expires_in: 86400` (24 h) in official examples — read `expires_in` dynamically, don't hardcode. Refresh tokens: no documented TTL or rotation policy; SDK persists a new `refresh_token` when returned — **musicsync must do the same**. Months-long unattended operation is implied, not guaranteed (D7).
- **Two-token strategy (required):** the catalog endpoint `GET /tracks` (ISRC lookup) lists only the INTERNAL-tier `r_usr` scope for user tokens, so a granular-scope user token may be rejected there. Use a **Client Credentials token for catalog/ISRC/search** and the **PKCE user token for playlist/collection operations**. (Verifier nuance: `GET /tracks/{id}` by ID does accept ordinary user tokens; the restriction concerns the multi-track `/tracks` endpoint carrying `filter[isrc]`.)

### 3.3 Scopes

From the official OpenAPI spec (v1.10.66), all THIRD_PARTY tier: `user.read`, `entitlements.read`, `playlists.read`, `playlists.write`, `collection.read`, `collection.write`, `recommendations.read`, `search.read`, `search.write`, `playback`. Legacy `r_usr`/`w_usr` are INTERNAL. musicsync needs: `playlists.read`, `playlists.write`, `user.read` (+ `collection.read` if collection playlists are surfaced). Note: search and ISRC lookup are **not** gated by `playlists.*` — they run on Client Credentials with no user scope.

### 3.4 Endpoint table

Base: `https://openapi.tidal.com/v2`. JSON:API throughout — `Content-Type: application/vnd.api+json`. **Pagination is exclusively opaque-cursor**: follow `links.next` (`page[cursor]`) to exhaustion; no page-size/offset parameters exist anywhere in the spec. `countryCode` is optional wherever it appears (80 of 340 operations; never required) and affects availability/licensing, not identity — pass the user's `country` from `/users/me`. Every mutation accepts an **`Idempotency-Key`** header (1 h replay window; 409 while in-flight; 422 on same key + different payload).

| Method | Path | Purpose | Caps / pagination / notes |
|---|---|---|---|
| GET | `/playlists?filter[owners.id]=me` | List the authenticated user's own playlists | Scope `playlists.read`. Cursor pagination. `sort`: ±`createdAt`/`lastModifiedAt`/`name`. `include=items,owners,coverArt…`. |
| GET | `/playlists/{id}` | One playlist (+items via `include`) | No scope (private resources behave as nonexistent if unauthorized). Attributes: `name`, `description`, `accessType` (`PUBLIC`\|`UNLISTED`), `numberOfItems`, `lastModifiedAt`, `playlistType`. |
| GET | `/playlists/{id}/relationships/items` | Page through playlist items | Cursor only; server-chosen page size. Each entry: `{id: trackId, type: "tracks"\|"videos", meta: {itemId, addedAt, itemCursor}}` — **capture `meta.itemId`**. `include=items` (+ `items.artists`, `items.albums`) embeds full track resources (attrs incl. `isrc` — required attribute, `title`, `version`, `duration` ISO-8601, `explicit`) to avoid N+1. |
| POST | `/playlists` | Create playlist | Scope `playlists.write`. `{"data":{"type":"playlists","attributes":{"name":req,"description":opt,"accessType":"PUBLIC"\|"UNLISTED"}}}` — **no PRIVATE**. 201 with new id. |
| PATCH | `/playlists/{id}` | Update name/description/accessType | JSON:API partial update; omitted attrs unchanged, null clears. Expect 204 (spec lists no 2xx body). |
| DELETE | `/playlists/{id}` | Delete playlist | `playlists.write`. |
| POST | `/playlists/{id}/relationships/items` | Add tracks/videos | ≤ **50** per call; `data[] = {id, type}`; omit top-level `meta` to append, `meta.positionBefore` for ordered insert (**value semantics undocumented — presumed itemId; verify at runtime**, §7-U2). |
| DELETE | `/playlists/{id}/relationships/items` | Remove items | ≤ **50** per call; each entry **requires `meta.itemId`** (playlist-entry id, not track id — duplicate-safe). Expect 204. |
| PATCH | `/playlists/{id}/relationships/items` | Reorder | ≤ **20** per call; per-item `meta.itemId` required + top-level `meta.positionBefore` required. |
| GET | `/tracks?filter[isrc]={isrc}` | **ISRC lookup** (also `filter[id]` batch) | Client Credentials token (see §3.2). Single ISRC → paginated, **multiple tracks may match**; multiple ISRCs → exactly one track per ISRC, no pagination. No documented array cap (URL length is the bound). |
| GET | `/searchResults/{urlencoded-query}` (+ `/relationships/tracks`) | Fallback text search | Client Credentials sufficient; `include=tracks` embeds resources; `explicitFilter`; cursor pagination on the relationship path. |
| GET | `/users/me` | Current user (`country`, `username`, `email`) | Scope `user.read`. `me` is a documented alias of `/users/{id}` (no distinct path). Use `country` as `countryCode`. |
| GET | `/userCollectionPlaylists/me/relationships/items` | Playlists in My Collection (created + followed) | Scope `collection.read`; cursor pagination; companion POST/DELETE (`collection.write`, ≤ 50) manage favorites. |
| — | `https://login.tidal.com/authorize` / `POST https://auth.tidal.com/v1/oauth2/token` | OAuth (PKCE S256) / all token grants | See §3.2. Device flow (`/v1/oauth2/device_authorization`) internal-only. |

Consistency note: writes are read-your-writes for the writing client only; other clients (the user's open TIDAL app) may see changes with delay.

### 3.5 Rate limits

**Undocumented.** The spec declares 429 on every endpoint with no numbers; the dedicated GitHub question (Dec 2025) is unanswered. History: token bucket ≈10 tokens, search costing 5, refill 1/s (≈1 search per 5 s); staff announced a "slightly more relaxed" scheme with `Retry-After` on 429s (Jul 14, 2025). Limits are per-Client-ID. One community report of quick 403 rate-limiting during development — back off on **403 and 429**. Budget conservatively: ~1 req/s sustained.

### 3.6 Program constraints

Beta platform; quotas fixed at "in development" level; spec iterates rapidly (pin behavior to OAS v1.10.66; deprecations promised ≥6 months notice; new enum values may appear at any time — parse defensively). Developer Terms v3.0 prohibit scraping/storing customer data beyond approved use and any use of TIDAL content with AI/ML — playlist snapshots for sync are low-risk but note Annex I wording. **No authenticated write call was executed during research** — smoke-test exact 2xx codes and `positionBefore` semantics with a real token before release.

---

## 4. Track Matching Strategy

### 4.1 ISRC-primary

Both platforms expose ISRC (July 2026, verified live):

- **Spotify:** `track.external_ids.isrc` (Feb 2026 removal **reverted** Mar 2026 — "will continue to be available") + `q=isrc:` search filter. Hydrate ISRCs in bulk via the `fields` parameter on `GET /playlists/{id}/items` (nested selection incl. `external_ids` verified) — this sidesteps the removed batch-track endpoint.
- **TIDAL:** `isrc` is a *required* track attribute; reverse lookup via `GET /tracks?filter[isrc]=` (Client Credentials token).

### 4.2 Failure modes (plan for 0..N candidates in both directions)

1. **One ISRC → many track IDs** on both platforms (multiple pressings/re-releases; TIDAL spec states this explicitly, with pagination).
2. **One recording → many ISRCs**: a *materially changed* recording (duration variants, alternate mixes/edits, creative restoration) gets a new ISRC per IFPI rules — a plain unchanged remaster keeps its ISRC. So ISRC miss ≠ track absent.
3. **No ISRC**: Spotify local files (`is_local=true`) — skip entirely (also cannot be added via API); user-uploaded/AI content.
4. **Region gaps**: TIDAL results are country-scoped for availability; an ISRC can return nothing or an unstreamable track for the configured country (exact `usageRules` semantics unverified — open ambiguity).

### 4.3 Recommended algorithm (adapted from spotify_to_tidal, verified in source; production since 2021)

```
match(masterTrack, candidate):
  isrc_equal(master, candidate)
  OR ( |duration_master − duration_candidate| < 2 s
       AND normalized_title_substring_match
       AND artist_name_set_overlap ≠ ∅ )
HARD EXCLUSION: reject if any of {"instrumental","acapella","remix"}
  appears on exactly one side — on TIDAL check BOTH title AND the
  separate `version` field.
```

Pipeline per master track:
1. **ISRC lookup** on slave platform. 0 results → step 2. ≥1 → filter by exclusion rule, prefer duration-closest / album-type release; **pick deterministically and persist** so reruns are stable.
2. **Metadata fallback search** — query formulations in order: `album + artist`, then `track + artist` (prior-art order); score candidates with the rule above. Spotify-direction search returns ≤10 candidates/page — use multiple query formulations, not deep paging.
3. **Normalization**: script-aware — casefold + NFKC always; ASCII-fold (NFD strip) **only when both strings are Latin** (naive NFD→ASCII deletes CJK entirely — known prior-art bug); strip bracket/hyphen version suffixes for the "simple" title form.
4. **Persistence**: mapping table `{master_id → slave_id, matched_by: isrc|fallback|manual, isrc}` + **failure cache** with retry-after-N-runs. Support a **manual override** config (pin master id → slave id) — the escape hatch commercial matchers (Soundiiz) provide.
5. Unmatched → the unmatchable report (§5); never fail the run.

Do not rely on Spotify `linked_from` for relinked-track resolution (removed for dev mode); use ISRC + duration/metadata instead.

---

## 5. Sync Algorithm Implications (master → slave)

**Diff model**
- Fetch master item list in order. Spotify master: short-circuit the whole run when `snapshot_id` is unchanged since last sync (persist it). TIDAL master: no snapshot equivalent — cheap pre-check via `lastModifiedAt`/`numberOfItems`, then full cursor walk and sequence compare.
- Translate master tracks → slave IDs through the mapping table (§4.4); compute an ordered diff (LCS or positional) against the current slave item sequence.
- **The slave playlist is fully owned by the tool** — document that manual edits to it will be overwritten. This makes replace-style writes safe and the algorithm simple.

**Applying the diff**
- *Spotify slave:* for full rewrites ≤100 tracks, one `PUT /items` (replace mode) sets exact contents+order in a single call; larger: `PUT` first 100 then `POST` appends in 100-chunks. Targeted removals: `DELETE` in 100-chunks with `snapshot_id` guard; chain each returned `snapshot_id` into the next mutation. Replace and reorder modes are mutually exclusive per request.
- *TIDAL slave:* adds ≤50/call (append preserves master order on initial build); removals ≤50/call and **require per-entry `meta.itemId`** — always re-fetch current items before mutating rather than trusting cached itemIds. Reorders ≤20/call with `positionBefore`; for large order drift it is cheaper to delete(itemId)+insert(positionBefore) targeted ranges, or rebuild the playlist, than to issue many PATCHes. Send an `Idempotency-Key` (e.g., hash of run-id+operation) on every mutation so cron-retry after a crash cannot double-apply; handle 422 `DUPLICATE_ITEMS_IN_COLLECTION` / `TOO_MANY_ITEMS_IN_COLLECTION` / `IDEMPOTENT_REQUEST_IN_PROGRESS`.

**Ordering** — preserve master order; on create, append in order (cheapest on both sides). On drift, minimal-move reordering (Spotify `range_start/insert_before`; TIDAL 20-item PATCH batches).

**Unmatchable tracks** — skip, record in a persisted report (track, reason, timestamp, retry count); surface in logs each run; never abort. Retry failures every N runs (new catalog additions resolve old misses).

**Idempotency** — the whole run must be re-runnable: deterministic candidate selection, persisted mapping, snapshot/`lastModifiedAt` short-circuits, `Idempotency-Key` on TIDAL writes, `snapshot_id` preconditions on Spotify deletes, and `noOverlap` scheduling (§6) so overlapping cron ticks can't interleave.

**Rate budget** — with batch reads removed on Spotify and ~1 req/s on TIDAL, a 1,000-track initial sync is thousands of requests; throttle globally, honor `Retry-After` on 429 (both) and 403 (TIDAL), and persist progress so a partial run resumes rather than restarts.

---

## 6. Implementation Stack Recommendations

| Concern | Recommendation | Why |
|---|---|---|
| HTTP client | **Native `fetch`** (stable Node global since v21), thin hand-rolled clients for both APIs | Spotify SDKs are effectively dead: `@spotify/web-api-ts-sdk` last release 1.2.0 (2024-01-17; last commit 2025-10-15; 48 open issues — treat as reference code only); `spotify-web-api-node` dead since 5.0.2 (**Jan 2021** — verifier-corrected date). Neither knows the 2026 `/items` paths. |
| TIDAL SDK | Skip `@tidal-music/auth`; implement the three documented grants directly. `@tidal-music/api` (0.34.0, active) is usable *if* you pass a custom `CredentialsProvider` — but a thin fetch wrapper over the OAS is simpler. | The auth package persists credentials via `globalThis.localStorage` (browser-bound; Node 24 gates localStorage behind `--experimental-webstorage`). **Refuted-claim correction:** the API README offers two co-equal Node options — polyfill localStorage *or* custom `CredentialsProvider` — it does not mandate the provider route; we choose raw OAuth for control over token persistence, not because the SDK forbids Node. |
| Scheduler | **`node-cron` v4.6.0** (2026-07-05) | Zero runtime deps, Node ≥20, TS, dual ESM/CJS; built-in **`noOverlap`**, `timezone`, `getNextRun`, graceful `shutdown()`. Competing `cron` pkg is healthy but luxon-based and mid-major-version (5.0.0-beta.1). Caveat: v4 API differs from the v3 shown in most tutorials. |
| Token persistence | JSON file in a volume-mounted config dir (e.g. `/config/tokens.json`), written atomically (tmp+rename), chmod 600. Store per-service: `access_token`, `expires_at`, `refresh_token`, `authorized_at` (drives the Spotify 6-month re-auth alarm). Always overwrite with newest returned refresh token (both platforms may rotate). | Matches the proven self-hosted pattern (multi-scrobbler): one-time interactive auth via temporary loopback HTTP server, tokens survive container recreation. |
| Auth bootstrap | On first run (or after `invalid_grant`): start a temporary HTTP server on `http://127.0.0.1:PORT` (Spotify-compliant loopback; also try for TIDAL — fall back to paste-the-callback-URL if TIDAL's dashboard rejects loopback, unverified), print the authorize URLs, capture codes, persist tokens, shut the server down. Emit loud warnings as the Spotify 6-month expiry approaches. | Spotify has no device flow; TIDAL's is internal-only. Loopback capture is the only headless-compatible pattern on both. |
| ENV config | Hand-rolled zero-dep validator for the ~10 vars (IDs, secrets, playlist pairs, direction, cron expr, market/countryCode, log level) | `envalid` fine but unnecessary; `znv` peer-pins zod ~3.24 while zod is at 4.x — avoid. |
| Docker | `node:24-alpine` (Node 20 EOL 2026-04-30; 24 is Active LTS), `USER node`, `CMD ["node","index.js"]` (npm swallows SIGTERM), compose `init: true` (Node isn't designed for PID 1), `env_file`, volume for `/config`, healthcheck | Straight from nodejs/docker-node best practices; alpine ~25% smaller than slim (musl caveat acceptable for a pure-JS tool). |
| Resilience | Global token-bucket throttle (~1 req/s TIDAL, adaptive Spotify), `Retry-After`-honoring retries, resumable run state, structured logging of the unmatchable report | Both platforms publish no numeric limits; TIDAL history shows aggressive throttling. |

---

## 7. Corrections & Open Questions

All 36 adversarially-verified claims: 34 confirmed, 2 refuted, 0 "unclear" verdicts issued. Refuted items and material corrections:

### Refuted (verifier overrides researcher)

| # | Original claim (topic) | Correction |
|---|---|---|
| R1 | *node-ecosystem:* "The `@tidal-music/api` README's documented path for Node.js is to implement your own CredentialsProvider … instead of using `@tidal-music/auth`." | **Refuted — overgeneralization.** The README documents **two co-equal options**: (1) polyfill/shim localStorage and keep `@tidal-music/auth`, or (2) custom `CredentialsProvider` via `createAPIClient(myAuthProvider)`; it explicitly says the choice depends on how much auth-flow control you need and recommends neither. musicsync's raw-OAuth choice stands on its own merits (§6). |
| R2 | *node-ecosystem:* "`spotify-web-api-node` has been dead since 5.0.2 in **December 2021**." | **Refuted on the date.** 5.0.2 shipped **2021-01-24 (January 2021)** — dormant even longer than claimed. The strategic conclusion (use native fetch) survives. |

### Confirmed-with-correction (researcher slightly off; verifier refinement adopted)

| # | Topic | Refinement |
|---|---|---|
| C1 | spotify-auth | Dev-mode policy changes effective precisely **Feb 11, 2026** (not "Feb/Mar"); one-Client-ID rule is in the blog but not yet on the quota-modes doc page; "indefinitely" is inferred from absence of any time limit, not Spotify's word. |
| C2 | spotify-auth / node-ecosystem | Redirect-URI enforcement: Apr 9, 2025 for new apps; **Nov 27, 2025** hard cutover for all (implicit grant, HTTP redirects, localhost aliases removed). |
| C3 | spotify-endpoints | `POST /me/playlists` is not a newly added path — it was in the "still available" set; only the `/items` endpoints are new. `GET /users/{id}/playlists` removed with **no replacement**. |
| C4 | spotify-endpoints | Search 10/5 limits now apply to **all** Development Mode apps (existing apps migrated Mar 9, 2026), not just new ones; extended quota exempt. |
| C5 | spotify-endpoints | Non-owned playlists: `GET /playlists/{id}` returns 200 metadata-only; the **403** is specific to `GET /playlists/{id}/items`. Premium requirement applies to all dev-mode apps, not just new. |
| C6 | tidal-auth | Scope gating evidence is stronger than researcher stated: Developer Terms document a formal Production-Mode approval (source-code review), and a second unanswered report (Nov 2025, 401 subStatus 6004 access-tier error) exists alongside the May 2026 one. Tier data lives in a vendor extension (`x-scopes-required-access-tier`). |
| C7 | tidal-auth | The researcher's cited portal URL for OAuth endpoints is a stale SPA path; endpoints were confirmed from official SDK source/spec instead (`login.tidal.com/authorize`, `auth.tidal.com/v1/oauth2/token`, S256 hardcoded, secret optional). |
| C8 | tidal-endpoints | `countryCode` is an accepted optional param on 80/340 operations (absent elsewhere; never required); its availability-only semantics are a structural inference, not documented. `/users/me` is the documented `me` alias of `/users/{id}`, not a distinct path. |
| C9 | matching-prior-art | TIDAL catalog/ISRC/search endpoints are not under `playlists.*` scopes — Client Credentials, no user scope. spotify_to_tidal dates to 2021 (older than "since 2022"). Remaster rule: new ISRC only on *material change*. |
| C10 | spotify-auth ↔ matching-prior-art (**researcher/verifier disagreement**) | Researchers reported endpoint restrictions postponed for pre-2026 Spotify apps; verifier found the Mar 9, 2026 migration confirmed shipped (changelog + real-world 403s). Moot for a new app — build against new paths only. |

### Open questions (no unclear verdicts, but unresolved risks to retire during implementation)

- **U1 (highest):** Does a fresh TIDAL Client ID get user-context scopes (`playlists.write` etc.) without an approval step? Two unanswered failure reports vs. self-service docs. **Action:** register the app and smoke-test the PKCE authorize flow *first*, before any other build work.
- **U2:** TIDAL `meta.positionBefore` value semantics (presumed itemId) and exact 2xx codes for DELETE/PATCH on `/relationships/items` — spec is silent; verify with a real token.
- **U3:** TIDAL refresh-token TTL/rotation — undocumented; instrument for `invalid_grant`-style failures and re-auth gracefully.
- **U4:** TIDAL redirect-URI rules (is HTTP loopback accepted in the dashboard?) — anecdotally yes (Nov 2024); confirm at app creation; keep paste-the-URL fallback.
- **U5:** TIDAL rate-limit numbers — undocumented; validate the ~1 req/s budget empirically; confirm `Retry-After` presence on 429 and behavior on 403.
- **U6:** Spotify refresh-token rotation — docs don't say whether an old token is invalidated when a new one is returned; always persist the newest.
- **U7:** Spotify exact 4xx bodies and dashboard registration flow post-Feb-2026 — docs partially predate the change; re-verify live.
- **U8:** TIDAL `usageRules`/availability semantics for country-scoped matches — unverified; treat "found but unstreamable" as a distinct match outcome.
- **U9:** Whether the TIDAL account needs a paid subscription for playlist writes — undocumented.
- **U10:** Spotify removal of local-file items — docs internally ambiguous (index+snapshot vs uri objects); tool skips `is_local` items anyway.

---

## 8. Sources (deduplicated)

**Spotify — docs & blog**
- https://developer.spotify.com/documentation/web-api/concepts/apps
- https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- https://developer.spotify.com/documentation/web-api/concepts/redirect_uri
- https://developer.spotify.com/documentation/web-api/concepts/scopes
- https://developer.spotify.com/documentation/web-api/concepts/access-token
- https://developer.spotify.com/documentation/web-api/concepts/rate-limits
- https://developer.spotify.com/documentation/web-api/concepts/authorization
- https://developer.spotify.com/documentation/web-api/concepts/track-relinking
- https://developer.spotify.com/documentation/web-api/concepts/playlists
- https://developer.spotify.com/documentation/web-api/tutorials/code-flow
- https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens
- https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow
- https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- https://developer.spotify.com/documentation/web-api/references/changes/february-2026
- https://developer.spotify.com/documentation/web-api/references/changes/march-2026
- https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security
- https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration
- https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api
- https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/

**Spotify — endpoint references**
- https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
- https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists
- https://developer.spotify.com/documentation/web-api/reference/get-playlist
- https://developer.spotify.com/documentation/web-api/reference/get-playlists-items
- https://developer.spotify.com/documentation/web-api/reference/get-playlists-tracks
- https://developer.spotify.com/documentation/web-api/reference/create-playlist
- https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist
- https://developer.spotify.com/documentation/web-api/reference/add-tracks-to-playlist
- https://developer.spotify.com/documentation/web-api/reference/remove-items-playlist
- https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items
- https://developer.spotify.com/documentation/web-api/reference/search
- https://developer.spotify.com/documentation/web-api/reference/get-track
- https://developer.spotify.com/documentation/web-api/reference/get-several-tracks

**TIDAL — official spec, portal, SDK**
- https://tidal-music.github.io/tidal-api-reference/ (reference SPA)
- https://tidal-music.github.io/tidal-api-reference/tidal-api-oas.json (OpenAPI 3.0.1, API v1.10.66 — primary source for all v2 endpoint facts)
- https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization (SPA; content verified via served JS chunks)
- https://developer.tidal.com/documentation/authorization/authorization-access-token
- https://developer.tidal.com/documentation/api-sdk/api-sdk-manage-apps
- https://developer.tidal.com/documentation/api-sdk/api-sdk-quick-start
- https://developer.tidal.com/documentation/api-sdk/api-sdk-overview
- https://developer.tidal.com/documentation/guidelines/guidelines-developer-terms-3_0
- https://developer.tidal.com/documentation/guidelines/guidelines-changelog
- https://github.com/tidal-music/tidal-sdk-web (auth/api packages; pushed 2026-07-20)
- https://github.com/tidal-music/tidal-sdk-web/blob/main/packages/auth/README.md
- https://github.com/tidal-music/tidal-sdk-web/blob/main/packages/auth/src/auth/auth.ts
- https://raw.githubusercontent.com/tidal-music/tidal-sdk-web/main/packages/auth/src/storage/database.ts
- https://raw.githubusercontent.com/tidal-music/tidal-sdk-web/main/packages/auth/src/storage/storage.ts
- https://raw.githubusercontent.com/tidal-music/tidal-sdk-web/main/packages/api/README.md
- https://github.com/tidal-music/tidal-sdk/blob/main/Auth.md
- https://registry.npmjs.org/@tidal-music/auth
- https://registry.npmjs.org/@tidal-music/api
- https://support.tidal.com/hc/en-us/articles/23052303648529-Tidal-for-Developers

**TIDAL — community/staff (GitHub org discussions)**
- https://github.com/orgs/tidal-music/discussions/6 (playlist write timeline, staff)
- https://github.com/orgs/tidal-music/discussions/26 (ISRC lookup history)
- https://github.com/orgs/tidal-music/discussions/115 (localhost redirect working, staff-confirmed authcode flow)
- https://github.com/orgs/tidal-music/discussions/135 (staff: Beta, no quota increases; Jul 2025 rate-limit relaxation + Retry-After)
- https://github.com/orgs/tidal-music/discussions/264 (401 subStatus 6004 access-tier error, unanswered)
- https://github.com/orgs/tidal-music/discussions/269 (rate limits undocumented, unanswered)
- https://github.com/orgs/tidal-music/discussions/285
- https://github.com/orgs/tidal-music/discussions/305 (tidal-cli, official-v2-only workflows)
- https://github.com/orgs/tidal-music/discussions/321 (client ID "not approved for Open API access", unanswered)

**Prior art & matching**
- https://github.com/spotify2tidal/spotify_to_tidal (+ issues #37 #167 #169 #171 #173 #184 #185 #192)
- https://raw.githubusercontent.com/spotify2tidal/spotify_to_tidal/main/src/spotify_to_tidal/sync.py (matcher source, verified)
- https://github.com/tamland/python-tidal (+ raw tidalapi/session.py)
- https://github.com/Zibbp/spotify-playlist-sync (+ tidal/*.go)
- https://socket.dev/pypi/package/tidal-dl-ng ; https://pypi.org/project/tidal-dl-ng/
- https://support.soundiiz.com/hc/en-us/articles/360012449999-Adding-a-matching-rule
- https://support.soundiiz.com/hc/en-us/articles/32567703886098
- https://isrc.ifpi.org/why-use-isrc/when-to-assign

**Node.js ecosystem & deployment**
- https://registry.npmjs.org/node-cron ; https://github.com/node-cron/node-cron (README, package.json, src/node-cron.ts, releases)
- https://registry.npmjs.org/cron ; https://github.com/kelektiv/node-cron (README, releases)
- https://api.npmjs.org/downloads/point/last-week/node-cron,cron
- https://registry.npmjs.org/@spotify/web-api-ts-sdk ; https://github.com/spotify/spotify-web-api-ts-sdk (+ commits)
- https://registry.npmjs.org/spotify-web-api-node
- https://registry.npmjs.org/envalid ; https://registry.npmjs.org/znv ; https://registry.npmjs.org/zod
- https://foxxmd.github.io/multi-scrobbler/configuration/sources/spotify/
- https://endoflife.date/nodejs
- https://nodejs.org/docs/latest-v24.x/api/globals.html
- https://raw.githubusercontent.com/nodejs/docker-node/main/docs/BestPractices.md
- https://raw.githubusercontent.com/nodejs/docker-node/main/README.md
- https://docs.docker.com/reference/compose-file/services/
