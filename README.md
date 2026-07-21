<p align="center">
  <img src="assets/logo.svg" width="84" alt="musicsync logo">
</p>

<h1 align="center">musicsync</h1>

<p align="center"><b>Self-hosted playlist sync between Spotify and TIDAL — one-way mirrors or full two-way sync, using only the official APIs.</b></p>

Runs headless in Docker with a small web panel: a first-launch **setup wizard** walks you through connecting both accounts, picking playlists, and choosing a schedule (or none — manual-only syncing is a first-class mode). To our knowledge this is the first Spotify↔TIDAL sync tool built purely on the official **Spotify Web API** (2026 Development-Mode endpoints) and the official **TIDAL API v2** — no reverse-engineered endpoints, no borrowed client ids.

## Features

- **Two sync modes**
  - *One-way mirror*: a source playlist is the truth; musicsync keeps an exact, ordered copy on the other platform.
  - *Two-way sync*: add or remove a track on either platform and it propagates to the other. Track sets stay equal; each platform keeps its own ordering.
- **Web panel** — setup wizard, dashboard (connection status, per-playlist `synced / total` counts, unmatched-track report, sync-now button), and live-applied settings. Password-protected (`WEB_PANEL_PASSWORD`) or explicitly open (`WEB_PANEL_BYPASS_AUTH=true`).
- **ISRC-first track matching** with a metadata fallback (duration ±2 s + normalized title + artist overlap) and hard version guards (a *remix/instrumental/acapella* never matches the plain recording)
- **Cron-scheduled or manual-only** — periodic sync is optional
- **Idempotent & resumable**: persisted match cache, change-token short-circuits, TIDAL `Idempotency-Key` mutations, atomic state writes
- Unmatched tracks never fail a run — they're reported in the panel and retried as catalogs change

## Install

### Quickstart (prebuilt image)

```bash
mkdir musicsync && cd musicsync
curl -LO https://raw.githubusercontent.com/eduardohartz/musicsync/main/compose.yml
curl -Lo .env https://raw.githubusercontent.com/eduardohartz/musicsync/main/.env.example
# edit .env: set WEB_PANEL_PASSWORD (one line — that's the only required config)
chown 1000 config
docker compose up -d
```

### Building from source

```bash
git clone https://github.com/eduardohartz/musicsync && cd musicsync
cp .env.example .env        # set WEB_PANEL_PASSWORD
docker compose -f compose.yml -f compose.build.yml up -d --build
```

### First run

Open **http://127.0.0.1:8080** and follow the setup wizard:

1. **Credentials** — create a (free) app on each platform; the wizard shows the exact redirect URIs to paste into their dashboards. Spotify requires the app owner to have Premium; TIDAL needs the `playlists.read`, `playlists.write`, `user.read` scopes enabled.
2. **Connect** — approve access on both platforms (OAuth runs through the panel; there's a paste-the-URL fallback for remote servers).
3. **Mode** — one-way mirror (pick the direction) or two-way sync.
4. **Playlists** — everything the account owns, or hand-picked.
5. **Schedule** — presets, custom cron, or *manual only*; optionally run the first sync immediately.

Done. The dashboard shows every playlist with its `synced / total` count and anything that couldn't be matched.

Running without Docker (Node ≥ 22.9): set `CONFIG_DIR=./config` in `.env`, then `npm ci && npm start` — the npm scripts load `.env` automatically.

## How the two modes behave

**One-way mirror** (`SYNC_MODE=one-way`): the mirror playlist belongs to the tool — order is kept identical to the source, and any manual edits on the mirror side are overwritten on the next run.

**Two-way sync** (`SYNC_MODE=two-way`): both playlists are yours to edit. After the first run establishes the link (a union merge — nothing is deleted), each subsequent run compares both sides against the last synced state: new tracks are added to the other platform, removed tracks are removed from the other platform. Removal wins over "untouched" (per-item edit timestamps don't exist on either API). Sets stay equal; ordering is per-platform; duplicates collapse (TIDAL playlists can't hold the same track twice).

## How matching works

1. **ISRC lookup** (the recording industry's identifier, exposed by both APIs). A single hit is authoritative; multiple hits are filtered by version guards and resolved deterministically (closest duration, then stable id order).
2. **Metadata fallback**: search album+artist, then track+artist; accept only when duration is within 2 s **and** normalized titles include one another **and** at least one artist matches. Normalization is script-aware (accent-folding for Latin, untouched CJK).
3. **No match** → the track stays where it is, appears in the panel's unmatched list, and is retried every `MATCH_RETRY_RUNS` runs. Manual overrides: `config/overrides.json` maps a track id to the id you want (`{ "4uLU6hMCjMI75M1A2tKUQC": "251380837" }`).

If the service starts without `WEB_PANEL_PASSWORD` or `WEB_PANEL_BYPASS_AUTH`, it exits immediately — the panel is the only way to set up and operate musicsync.

## Configuration reference

Everything is optional except the panel credential — setup happens in the web panel, which writes your choices to `config/settings.json`. ENV values (see `.env.example`) merely seed initial values for pre-provisioned deploys; panel settings override them.

| Variable | Default | Description |
|---|---|---|
| `WEB_PANEL_PASSWORD` | — | Enables the panel with password login |
| `WEB_PANEL_BYPASS_AUTH` | `false` | Enables the panel **without authentication** — trusted networks only |
| `PORT` | `8080` | Panel port (OAuth redirect URIs use it) |
| `APP_URL` | `http://127.0.0.1:$PORT` | Public base URL of the panel — the OAuth redirect URIs become `$APP_URL/callback/…`. Set when behind a reverse proxy; Spotify requires HTTPS for anything other than `127.0.0.1` |
| `SPOTIFY_CLIENT_ID/SECRET`, `TIDAL_CLIENT_ID/SECRET` | — | Platform app credentials (or enter in the wizard) |
| `SYNC_MODE` | `one-way` | `one-way` \| `two-way` |
| `SYNC_SOURCE` | — | One-way only: `spotify` \| `tidal` — the source of truth |
| `SYNC_PLAYLISTS` | — | `all`, or comma-separated playlist ids; `primaryId:secondaryId` links existing pairs |
| `SYNC_PERIODIC` | `true` | `false` = manual-only syncing |
| `SYNC_CRON` | `0 */6 * * *` | Schedule when periodic |
| `SYNC_ON_START` / `SYNC_TZ` / `DRY_RUN` / `LOG_LEVEL` / `MATCH_RETRY_RUNS` | | See `.env.example` |
| `SPOTIFY_MARKET` / `TIDAL_ACCESS_TYPE` / `SPOTIFY_PLAYLIST_PUBLIC` | | See `.env.example` |
| `CONFIG_DIR` | `/config` | Tokens, settings, state, reports (volume-mount this) |
| `PANEL_BIND` | `127.0.0.1` | Panel bind address (Docker image binds `0.0.0.0`) |

## Limitations (read this once)

- **Spotify re-authorization every ≤ 6 months** — Spotify refresh tokens hard-expire 6 months after consent (platform rule for every app). The panel shows a countdown and the service goes `unhealthy` with clear instructions when it lapses; nothing is lost.
- **Spotify Premium is required** for the app owner, and only playlists you own or collaborate on can be read (2026 Development-Mode rules).
- **TIDAL's public API is beta** — undocumented rate limits (musicsync throttles to ~1 req/s and honors `Retry-After`); occasional reports of new client ids lacking user scopes — the wizard's connect step surfaces this immediately.
- **TIDAL has no private playlists** (created mirrors are `UNLISTED` by default) and **can't hold duplicate tracks** (duplicates collapse when syncing to TIDAL).
- **Two-way sync is set-based**: ordering isn't reconciled across platforms, and a track removed on one side while untouched on the other is treated as a removal.
- **Spotify local files** can't sync (no ISRC, not addable via API); TIDAL **videos** are left in place but never propagated.
- Initial syncs of large libraries are deliberately slow (~1 request/second against TIDAL; Spotify batch endpoints no longer exist).
- The panel binds to the host loopback by default. For remote access, use an SSH tunnel, or put an HTTPS reverse proxy in front and set `APP_URL` to its public URL (the wizard's redirect URIs follow it).

## Development

```bash
npm ci
npm test        # node:test — no test dependencies
```

Design docs live in `docs/`: [API research](docs/research/api-research.md) (live-verified endpoint tables for both platforms), [v0.1 design](docs/superpowers/specs/2026-07-20-musicsync-design.md), [v0.2 design (panel + two-way)](docs/superpowers/specs/2026-07-20-web-panel-two-way-design.md).

Contributions welcome — runtime dependencies are deliberately minimal (`node-cron`, `express`), the frontend is no-build vanilla JS, and platform behavior changes should update the research doc.

## License

[MIT](LICENSE)
