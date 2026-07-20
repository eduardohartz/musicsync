import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { generatePkce } from '../platforms/tidal.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const SESSION_COOKIE = 'musicsync_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const passwordsEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => {
      const i = part.indexOf('=');
      return i === -1 ? [part.trim(), ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    }),
  );
}

/**
 * Web panel: dashboard, settings, first-run setup wizard, and the primary
 * OAuth callback flow.
 *
 * Runs only when WEB_PANEL_PASSWORD is set or WEB_PANEL_BYPASS_AUTH=true.
 * The runtime object (src/index.js) owns config/adapters/engine and is
 * re-read on every request so panel-applied settings take effect live.
 */
export function createWebServer({ runtime, logger }) {
  const log = logger.child('panel');
  const app = express();
  const sessions = new Map(); // token -> createdAt
  const pendingAuth = {};     // platform -> {state, verifier?}

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const cfg = () => runtime.config();

  function isAuthed(req) {
    if (cfg().panel.bypassAuth) return true;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const createdAt = token && sessions.get(token);
    if (!createdAt) return false;
    if (Date.now() - createdAt > SESSION_TTL_MS) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'unauthorized' });
  }

  // ---- session -------------------------------------------------------------
  app.post('/api/login', async (req, res) => {
    const password = cfg().panel.password;
    if (!password) return res.status(400).json({ error: 'authentication disabled' });
    const attempt = String(req.body?.password ?? '');
    if (!passwordsEqual(attempt, password)) {
      await new Promise((r) => setTimeout(r, 400)); // soften brute force
      return res.status(401).json({ error: 'wrong password' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    if (sessions.size > 100) sessions.clear(); // tiny store, single user
    sessions.set(token, Date.now());
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    res.json({ authed: isAuthed(req), authDisabled: cfg().panel.bypassAuth });
  });

  // ---- OAuth (primary flow) ------------------------------------------------
  const redirectUri = (platform) => `http://127.0.0.1:${cfg().panel.port}/callback/${platform}`;

  app.get('/auth/:platform', requireAuth, (req, res) => {
    const { platform } = req.params;
    if (!['spotify', 'tidal'].includes(platform)) return res.status(404).send('unknown platform');
    const config = cfg();
    if (config.incomplete.some((i) => i.toLowerCase().includes(`${platform} client`))) {
      return res.status(400).send(`${platform} client credentials are not configured yet`);
    }
    const state = crypto.randomUUID();
    const adapters = runtime.adapters();
    let url;
    if (platform === 'tidal') {
      const { verifier, challenge } = generatePkce();
      pendingAuth.tidal = { state, verifier };
      url = adapters.tidal.buildAuthorizeUrl({ redirectUri: redirectUri('tidal'), state, challenge });
    } else {
      pendingAuth.spotify = { state };
      url = adapters.spotify.buildAuthorizeUrl({ redirectUri: redirectUri('spotify'), state });
    }
    res.redirect(url);
  });

  async function completeCallback(platform, query) {
    const pending = pendingAuth[platform];
    if (!pending) throw new Error(`no authorization in progress for ${platform}`);
    if (query.error) throw new Error(`${platform} authorization denied: ${query.error}`);
    if (!query.code) throw new Error('callback is missing the code parameter');
    if (query.state !== pending.state) throw new Error('state mismatch — stale or forged callback');
    const adapters = runtime.adapters();
    if (platform === 'tidal') {
      await adapters.tidal.exchangeCode({ code: query.code, redirectUri: redirectUri('tidal'), verifier: pending.verifier });
    } else {
      await adapters.spotify.exchangeCode({ code: query.code, redirectUri: redirectUri('spotify') });
    }
    delete pendingAuth[platform];
    runtime.onConnected(platform);
    log.info(`${platform} connected via panel`);
  }

  app.get('/callback/:platform', requireAuth, async (req, res) => {
    const { platform } = req.params;
    if (!['spotify', 'tidal'].includes(platform)) return res.status(404).send('unknown platform');
    try {
      await completeCallback(platform, req.query);
      res.redirect(`/?connected=${platform}`);
    } catch (err) {
      log.error(`${platform} callback failed`, { error: String(err) });
      res.redirect(`/?authError=${encodeURIComponent(err.message)}`);
    }
  });

  // Fallback for remote installs where 127.0.0.1 redirects can't reach the
  // server: the user pastes the full redirect URL from their address bar.
  app.post('/api/auth/manual', requireAuth, async (req, res) => {
    try {
      const url = new URL(String(req.body?.url ?? ''), 'http://127.0.0.1');
      const m = /^\/callback\/(spotify|tidal)$/.exec(url.pathname);
      if (!m) return res.status(400).json({ error: 'not a musicsync callback URL' });
      await completeCallback(m[1], Object.fromEntries(url.searchParams));
      res.json({ ok: true, platform: m[1] });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- API -----------------------------------------------------------------
  app.get('/api/overview', requireAuth, (req, res) => {
    res.json(runtime.overview());
  });

  app.get('/api/settings', requireAuth, (req, res) => {
    const config = cfg();
    res.json({
      spotify: {
        clientId: config.spotify.clientId,
        clientSecretSet: Boolean(config.spotify.clientSecret),
        market: config.spotify.market,
        playlistPublic: config.spotify.playlistPublic,
      },
      tidal: {
        clientId: config.tidal.clientId,
        clientSecretSet: Boolean(config.tidal.clientSecret),
        accessType: config.tidal.accessType,
      },
      sync: { ...config.sync },
      logLevel: config.logLevel,
      redirectUris: {
        spotify: redirectUri('spotify'),
        tidal: redirectUri('tidal'),
      },
    });
  });

  app.put('/api/settings', requireAuth, async (req, res) => {
    try {
      const config = await runtime.applySettings(req.body ?? {});
      res.json({ ok: true, incomplete: config.incomplete });
    } catch (err) {
      res.status(400).json({ error: err.message, problems: err.problems });
    }
  });

  app.get('/api/playlists/:platform', requireAuth, async (req, res) => {
    const { platform } = req.params;
    if (!['spotify', 'tidal'].includes(platform)) return res.status(404).json({ error: 'unknown platform' });
    try {
      res.json({ playlists: await runtime.adapters()[platform].listOwnPlaylists() });
    } catch (err) {
      res.status(502).json({ error: `could not list ${platform} playlists: ${err.message}` });
    }
  });

  app.post('/api/sync', requireAuth, (req, res) => {
    const result = runtime.triggerSync('panel');
    if (result.busy) return res.status(409).json({ error: 'a sync is already running' });
    if (result.blocked) return res.status(400).json({ error: result.blocked });
    res.json({ ok: true });
  });

  app.post('/api/setup/complete', requireAuth, async (req, res) => {
    await runtime.completeSetup();
    if (req.body?.runNow) runtime.triggerSync('setup');
    res.json({ ok: true });
  });

  app.get('/api/unmatched', requireAuth, (req, res) => {
    res.json(runtime.unmatchedReport());
  });

  // ---- static --------------------------------------------------------------
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  return {
    app,
    start() {
      const { port, bind } = cfg().panel;
      const server = app.listen(port, bind, () => {
        log.info(`web panel listening on http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`, {
          auth: cfg().panel.bypassAuth ? 'DISABLED (bypass)' : 'password',
        });
      });
      server.on('error', (err) => log.error('web panel failed to start', { error: String(err) }));
      return server;
    },
  };
}
