import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { generatePkce } from '../platforms/tidal.js';

/**
 * Parse an OAuth callback (server request path or pasted full URL) against
 * the pending auth attempts. Returns {service, code} or {error}.
 */
export function parseCallbackUrl(rawUrl, pending) {
  let url;
  try {
    url = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    return { error: `not a valid URL: ${rawUrl}` };
  }
  const m = /^\/callback\/(spotify|tidal)$/.exec(url.pathname);
  if (!m) return { error: `unexpected callback path "${url.pathname}"` };
  const service = m[1];
  const entry = pending[service];
  if (!entry) return { error: `no authorization pending for ${service}` };
  const errParam = url.searchParams.get('error');
  if (errParam) return { error: `${service} authorization was denied: ${errParam}` };
  const code = url.searchParams.get('code');
  if (!code) return { error: `${service} callback is missing the code parameter` };
  if (url.searchParams.get('state') !== entry.state) {
    return { error: `${service} state mismatch — possible CSRF or stale URL, ignoring` };
  }
  return { service, code };
}

/** Decide which services need interactive authorization. */
export function servicesNeedingAuth(tokens, { force = false } = {}) {
  return ['spotify', 'tidal'].filter((svc) => force || !tokens.get(svc)?.refreshToken);
}

/**
 * One-time interactive OAuth bootstrap. Serve mode captures redirects on a
 * temporary loopback HTTP server; manual mode reads pasted redirect URLs from
 * stdin (for machines where the browser can't reach the container).
 */
export async function runAuthBootstrap({
  config, tokens, adapters, logger,
  manual = false, force = false,
  stdout = process.stdout, stdin = process.stdin,
  timeoutMs = 10 * 60 * 1000,
}) {
  const log = logger.child('auth');
  const redirect = (svc) => `http://127.0.0.1:${config.authPort}/callback/${svc}`;
  const pending = {};

  for (const svc of servicesNeedingAuth(tokens, { force })) {
    const state = crypto.randomUUID();
    if (svc === 'tidal') {
      const { verifier, challenge } = generatePkce();
      pending.tidal = {
        state, verifier,
        url: adapters.tidal.buildAuthorizeUrl({ redirectUri: redirect('tidal'), state, challenge }),
      };
    } else {
      pending.spotify = {
        state,
        url: adapters.spotify.buildAuthorizeUrl({ redirectUri: redirect('spotify'), state }),
      };
    }
  }

  if (Object.keys(pending).length === 0) {
    stdout.write('All services are already authorized. Use --force to re-authorize.\n');
    return [];
  }

  stdout.write('\nOpen the following URL(s) in your browser and approve access:\n\n');
  for (const [svc, entry] of Object.entries(pending)) {
    stdout.write(`  [${svc}]\n  ${entry.url}\n\n`);
  }
  if (manual) {
    stdout.write('After approving, your browser will be redirected to a http://127.0.0.1 URL\n'
      + '(the page itself may fail to load — that is fine). Copy the FULL URL from the\n'
      + "browser's address bar and paste it here. One URL per line:\n\n");
  }

  const completed = [];
  async function exchange(service, code) {
    if (service === 'spotify') {
      await adapters.spotify.exchangeCode({ code, redirectUri: redirect('spotify') });
    } else {
      await adapters.tidal.exchangeCode({ code, redirectUri: redirect('tidal'), verifier: pending.tidal.verifier });
    }
    delete pending[service];
    completed.push(service);
    log.info(`${service} authorized and tokens persisted`);
    stdout.write(`  ✔ ${service} authorized\n`);
  }

  if (manual) {
    const rl = readline.createInterface({ input: stdin });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = parseCallbackUrl(trimmed, pending);
        if (parsed.error) {
          stdout.write(`  ✖ ${parsed.error}\n`);
          continue;
        }
        await exchange(parsed.service, parsed.code);
        if (Object.keys(pending).length === 0) break;
      }
    } finally {
      rl.close();
    }
    if (Object.keys(pending).length > 0) {
      throw new Error(`authorization incomplete for: ${Object.keys(pending).join(', ')}`);
    }
    return completed;
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = parseCallbackUrl(req.url, pending);
      if (parsed.error) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(parsed.error);
        return;
      }
      try {
        await exchange(parsed.service, parsed.code);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>musicsync: ${parsed.service} authorized ✔</h2>You can close this tab.</body></html>`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`token exchange failed: ${err.message}`);
        log.error(`token exchange failed for ${parsed.service}`, { error: String(err) });
        return;
      }
      if (Object.keys(pending).length === 0) {
        clearTimeout(timer);
        server.close(() => resolve(completed));
      }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 60000)} min waiting for authorization`));
    }, timeoutMs);
    // Bind all interfaces: inside Docker the published port must be reachable,
    // while the registered redirect URI stays http://127.0.0.1 for the browser.
    server.listen(config.authPort, '0.0.0.0', () => {
      stdout.write(`Waiting for OAuth callbacks on port ${config.authPort} `
        + `(redirect URIs use http://127.0.0.1:${config.authPort}/callback/...)\n`);
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
