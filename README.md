# musicsync

**Self-hosted, one-way playlist sync between Spotify and TIDAL — using only the official APIs.**

Pick a *master* platform (your source of truth); musicsync mirrors its playlists to the *slave* platform on a cron schedule. Runs headless in Docker, configured entirely through environment variables.

To our knowledge this is the first Spotify↔TIDAL sync tool built purely on the official **Spotify Web API** (2026 Development-Mode endpoints) and the official **TIDAL API v2** (`openapi.tidal.com`) — no reverse-engineered endpoints, no embedded borrowed client ids.

## Features

- **One-way master → slave sync** in either direction (`SYNC_MASTER=spotify` or `tidal`)
- **ISRC-first track matching** with a metadata fallback (duration ±2 s + normalized title + artist overlap) and hard version guards (a *remix/instrumental/acapella* never matches the plain recording)
- Sync **all owned playlists** or an explicit list; mirrors are auto-created or pinned to existing playlists
- **Cron-scheduled** (`node-cron`, overlap-safe), with immediate sync on start
- **Idempotent & resumable**: persisted match cache, change-token short-circuits, TIDAL `Idempotency-Key` mutations, atomic state writes
- **Unmatched report** (`config/unmatched.json`) — a missing match never fails a run; misses are retried every `MATCH_RETRY_RUNS` runs
- **Manual overrides** (`config/overrides.json`) to pin stubborn tracks
- **Dry-run mode**, structured logs, Docker `HEALTHCHECK`
- Tiny footprint: one runtime dependency (`node-cron`), native `fetch`, plain JSON state

## Setup

### 1. Register your own API apps (one time, ~10 minutes)

**Spotify** — [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
> ⚠️ Spotify's 2026 Development-Mode rules: the app **owner must have an active Premium subscription**, you get **one app** per developer, and up to **5 authorized users**. Personal, non-commercial use is exactly what Development Mode is for.

1. Create an app; add redirect URI `http://127.0.0.1:8888/callback/spotify` (the literal IP — Spotify rejects `localhost`).
2. Copy the Client ID and Client Secret.

**TIDAL** — [developer.tidal.com/dashboard](https://developer.tidal.com/dashboard) (any TIDAL account)

1. Create an app; add redirect URI `http://127.0.0.1:8888/callback/tidal`.
2. In the app's settings enable scopes **`playlists.read`, `playlists.write`, `user.read`**.
3. Copy the Client ID and Client Secret.

### 2. Configure

```bash
git clone https://github.com/OWNER/musicsync && cd musicsync
cp .env.example .env
# fill in the four credentials + SYNC_MASTER + SYNC_PLAYLISTS
```

### 3. Authorize (one time)

```bash
docker compose build
docker compose run --rm -p 127.0.0.1:8888:8888 musicsync auth
```

Open the printed URL(s), approve access, done — tokens land in `./config/tokens.json` (mode 600) and survive container recreation.

Running on a remote server where your browser can't reach the container? Use `musicsync auth --manual`: open the URLs anywhere, then paste the full `http://127.0.0.1:8888/...` redirect URL from your browser's address bar back into the terminal.

> This first `auth` run also doubles as a smoke test that TIDAL accepted your app for user-level scopes (the platform is still in beta — see Limitations).

### 4. Run

```bash
docker compose up -d
docker compose logs -f          # watch the first sync
```

Without Docker: `npm ci && CONFIG_DIR=./config npm run auth && CONFIG_DIR=./config npm start` (Node ≥ 22).

### Useful commands

```bash
docker compose run --rm musicsync status      # auth state, pair state, cache sizes
docker compose run --rm musicsync sync-once   # single sync, then exit
cat config/unmatched.json                     # tracks that couldn't be matched
```

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | — | Your Spotify app credentials |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` | — | Your TIDAL app credentials |
| `SYNC_MASTER` | — | `spotify` \| `tidal` — the source of truth |
| `SYNC_PLAYLISTS` | — | `all`, or comma-separated master playlist ids; `masterId:slaveId` pins an existing mirror |
| `SYNC_CRON` | `0 */6 * * *` | Sync schedule (cron) |
| `SYNC_ON_START` | `true` | Sync immediately when the service starts |
| `SYNC_TZ` | system | Timezone for the cron expression |
| `SPOTIFY_MARKET` | `US` | Market for Spotify search |
| `TIDAL_ACCESS_TYPE` | `UNLISTED` | Created TIDAL playlists: `PUBLIC` \| `UNLISTED` |
| `SPOTIFY_PLAYLIST_PUBLIC` | `false` | Created Spotify playlists public? |
| `DRY_RUN` | `false` | Log the diff, write nothing |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `MATCH_RETRY_RUNS` | `10` | Retry unmatched tracks every N runs |
| `CONFIG_DIR` | `/config` | Tokens, state, reports (volume-mount this) |
| `AUTH_PORT` | `8888` | Loopback port for the one-time OAuth bootstrap |

### Manual match overrides

Create `config/overrides.json` mapping a master track id to the slave track id you want:

```json
{ "4uLU6hMCjMI75M1A2tKUQC": "251380837" }
```

## How matching works

1. **ISRC lookup** on the slave platform (the recording industry's identifier, exposed by both APIs). Multiple hits are filtered by version guards and resolved deterministically (closest duration, then stable id order).
2. **Metadata fallback**: search by album+artist, then track+artist; accept only when duration is within 2 s **and** normalized titles include one another **and** at least one artist matches. Normalization is script-aware (accent-folding for Latin, untouched CJK).
3. **No match** → the track is skipped, recorded in `config/unmatched.json`, and retried every `MATCH_RETRY_RUNS` runs (catalogs change). The playlist still syncs.

## Limitations (read this once)

- **The mirror playlist belongs to the tool.** Manual edits on the slave side are overwritten on the next sync.
- **Spotify re-authorization every ≤ 6 months.** Spotify refresh tokens hard-expire 6 months after consent (platform rule, for every app). musicsync warns in the logs from day ~150, and if the token dies the service goes `unhealthy` and logs exactly what to run — it never crash-loops or deletes anything.
- **Spotify Premium is required** for the app owner (Development Mode rule since Feb 2026).
- **Only playlists you own or collaborate on** can be a Spotify master (Development Mode restriction; followed/editorial playlists are unreadable).
- **TIDAL's public API is beta.** Rate limits are undocumented (musicsync throttles itself to ~1 req/s and honors `Retry-After`); a fresh TIDAL app being denied user scopes has been reported occasionally — the `auth` step will tell you immediately.
- **TIDAL has no private playlists** — mirrors there are `UNLISTED` (default) or `PUBLIC`.
- **Spotify local files** can't be synced (no ISRC, not addable via API); they're reported as unmatched.
- Initial syncs of large libraries are deliberately slow (both platforms removed/never had batch reads; expect ~1 request/second against TIDAL).

## Development

```bash
npm ci
npm test        # node:test, no test dependencies
```

Design docs live in `docs/`: [API research](docs/research/api-research.md) (live-verified endpoint tables for both platforms, July 2026), [design spec](docs/superpowers/specs/2026-07-20-musicsync-design.md), [implementation plan](docs/superpowers/plans/2026-07-20-musicsync.md).

Contributions welcome — please keep the zero-dependency spirit (native `fetch`, `node:test`) and update the research doc when platform behavior changes.

## License

[MIT](LICENSE)
