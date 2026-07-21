# musicsync v0.2 — Web Panel, Two-Way Sync, Naming — Design Addendum

**Date:** 2026-07-20 · **Extends:** `2026-07-20-musicsync-design.md` · **Status:** approved for implementation (autonomous session; requirements given verbatim by user)

## 1. Naming: source / mirror (replaces master/slave)

- ENV `SYNC_SOURCE=spotify|tidal` replaces `SYNC_MASTER`. Docs say "source" and "mirror".
- Two-way mode has no source; pairs are just *linked playlists*.
- State schema uses explicit platform names (clearer than role names):
  ```js
  pairs[pairKey] = {
    spotifyPlaylistId, tidalPlaylistId, name,
    spotifyChangeToken, tidalChangeToken,
    unmatchedCount, lastSyncedAt,
    lastResult: { status, matched, total, unmatched, at },
    baseline: [{ spotify, tidal }],   // two-way only
  }
  ```
  `pairKey` = the configured/primary playlist id (source-platform id in one-way; Spotify id in two-way).
- Mappings become bidirectional: every successful match records both `spotify:{id} → tidalId` and `tidal:{id} → spotifyId` (field `matchedId`). Matcher signature: `matchTrack(track, fromPlatform, toPlatform)`.
- Clean break, no compat shims (v0.1 unreleased).

## 2. Two-way sync (`SYNC_MODE=two-way`)

**Semantics: set-based, no ordering guarantees.** Adds/removals propagate both ways; duplicates collapse; each platform keeps its own ordering (new tracks append). One-way mode keeps the existing ordered mirror semantics.

Per pair, per run (skip when both change tokens unchanged):
1. Fetch both sides' items (drop local/video); dedupe to sets.
2. **No baseline yet (first two-way run):** merge — match each side's tracks to the other, add what's missing on each side, no removals; baseline = all matched pairs. Unmatched tracks stay platform-local, reported, retried later.
3. **With baseline (three-way diff, pure function `computeTwoWayOps`):**
   - pair in baseline, present both sides → keep.
   - present on Spotify only → was removed on TIDAL → remove from Spotify (removal wins; re-add vs untouched is indistinguishable without per-item timestamps — documented).
   - present on TIDAL only → remove from TIDAL.
   - gone from both → drop from baseline.
   - new on either side (not in baseline) → match to the other side; add if absent there; new baseline entry. Match failure → unmatched report + failure cache, not in baseline.
4. Apply removals then adds via new adapter methods `removeTracks(playlistId, items)` (Spotify: DELETE by uri with snapshot guard — removes all occurrences, fine under set semantics; TIDAL: DELETE by fresh itemId) and `addTracks(playlistId, ids)` (append chunks). Partial drops leave tokens stale (same self-heal rule as v0.1).
5. Persist baseline + change tokens + `lastResult`.

## 3. Configuration: ENV seeds, panel owns

- New `settings.json` in `CONFIG_DIR` (0600, atomic) — written by the web panel. Merge rule: **settings.json overrides ENV for app settings** (credentials, mode, source, pairs, schedule, market, access types, log level, dry-run, retry). ENV-only (bootstrap/secrets-of-the-panel): `PORT`, `WEB_PANEL_PASSWORD`, `WEB_PANEL_BYPASS_AUTH`, `CONFIG_DIR`, `AUTH_PORT`, `AUTH_BIND`.
- `loadConfig` no longer throws on incomplete app config; it returns `config.incomplete` (list of gaps). Fatal only for malformed values. Service decides: panel available → setup mode; no panel → exit with guidance (ENV-only path still fully works headless).
- **Schedule:** `periodic: true|false` (ENV `SYNC_PERIODIC`, default true when cron given). `periodic=false` → no cron task; syncs run only via panel button, wizard's first-sync, or `sync-once` CLI.

## 4. Web panel

- **Enablement:** starts iff `WEB_PANEL_PASSWORD` set **or** `WEB_PANEL_BYPASS_AUTH=true`. Listens on `PORT` (default 8080), bind `0.0.0.0` in Docker (image env) / `127.0.0.1` native (same AUTH_BIND-style rule via `PANEL_BIND`? — reuse: panel binds 0.0.0.0 in container via env `PANEL_BIND`, default `127.0.0.1` natively).
- **Auth:** login form → constant-time password check → random 128-bit session token (in-memory set) in httpOnly SameSite=Lax cookie. Logout invalidates. Bypass mode skips all of it.
- **OAuth via panel (primary flow):** `GET /auth/:platform` 302s to the provider (state per attempt, PKCE for TIDAL) with redirect URI `http://127.0.0.1:{PORT}/callback/:platform`; `/callback/:platform` exchanges + persists tokens and bounces back into the UI. The `:8888` CLI bootstrap remains for headless installs.
- **API (JSON, all auth-gated):** `POST /api/login|logout` · `GET /api/overview` (setup-needed, per-platform auth incl. Spotify days-left, mode, schedule, next run, syncing flag, per-pair `{name, ids, lastResult: matched/total/unmatched, lastSyncedAt}`) · `GET|PUT /api/settings` (secrets masked on read; hot-applies: rebuilds adapters/engine, reschedules cron) · `GET /api/playlists/:platform` (for the picker) · `POST /api/sync` (409 while running) · `GET /api/unmatched`.
- **Views:** login · **setup wizard** (welcome/credentials with copy-paste redirect URIs → connect both accounts (live status) → mode: one-way (pick direction) / two-way → playlist selection (all-owned toggle or explicit picks) → schedule (presets 15m/1h/6h/daily/custom cron/**manual only**) → review + save + optional first sync) · **dashboard** (connection cards, sync state, playlist table with `succeeded/total` per pair, unmatched drawer, run-now) · **settings** (same fields as wizard, editable).
- **Design (ui-craft):** soft-modern; warm neutral surfaces + single indigo accent within budget; system-ui type, sentence case, `tabular-nums` on counts; radius 6/10/14; layered shadows; inline Lucide-path SVG icons; light+dark via CSS token variables (`prefers-color-scheme`); motion ≤200ms, `prefers-reduced-motion` honored; signature motif: the logo's sync-loop arc as wizard connector + sync spinner.
- **Logo:** `assets/logo.svg` — circular two-arc sync loop (indigo→teal gradient, the one place gradient is allowed: brand mark) + dot accents; reused in panel header and README.

## 5. Orchestration

`index.js` runtime object: `{ state: setup|idle|syncing|auth_required, currentPair, config, rebuild() }`. Panel and cron share one `runOnce` guard. Settings PUT → validate → write → `rebuild()` (new config/adapters/engine, cron rescheduled or stopped). Setup completion flips state without restart. Docker: `EXPOSE 8080`, compose publishes `127.0.0.1:8080:8080` by default; healthcheck unchanged (panel is not the heartbeat).

## 6. Out of scope (documented)

Two-way ordering reconciliation; per-item conflict timestamps; multiple users; HTTPS termination (reverse-proxy advice in README); playlist renames propagating.
