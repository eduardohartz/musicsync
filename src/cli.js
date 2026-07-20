#!/usr/bin/env node
import { createRuntime, main } from './index.js';
import { ConfigError } from './config.js';
import { runAuthBootstrap } from './auth/bootstrap.js';

const USAGE = `musicsync — playlist sync between Spotify and TIDAL

Usage:
  musicsync                 start the service (scheduled sync + web panel)
  musicsync auth            headless OAuth bootstrap on the AUTH_PORT loopback
      --manual              paste redirect URLs instead of a local callback server
      --force               re-authorize even if tokens exist
  musicsync sync-once       run a single sync and exit
  musicsync status          show auth and sync state

The web panel (set WEB_PANEL_PASSWORD or WEB_PANEL_BYPASS_AUTH=true, open
http://127.0.0.1:$PORT) is the primary way to set up and operate musicsync;
these commands cover headless installs.
`;

function runtimeOrExit() {
  try {
    return createRuntime();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function run() {
  const [cmd, ...flags] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'run':
      return main();

    case 'auth': {
      const runtime = runtimeOrExit();
      const config = runtime.config();
      if (config.incomplete.some((i) => i.includes('client'))) {
        process.stderr.write(`Cannot authorize yet — missing: ${config.incomplete.join(', ')}\n`);
        process.exit(1);
      }
      const completed = await runAuthBootstrap({
        config,
        tokens: runtime.tokens,
        adapters: runtime.adapters(),
        logger: runtime.logger,
        manual: flags.includes('--manual'),
        force: flags.includes('--force'),
      });
      if (completed.length > 0) {
        process.stdout.write('\nDone. Start the service with "docker compose up -d" or "npm start".\n');
      }
      return undefined;
    }

    case 'sync-once': {
      const runtime = runtimeOrExit();
      if (!runtime.ready()) {
        const config = runtime.config();
        process.stderr.write(`Cannot sync: ${config.incomplete.join(', ') || 'accounts not connected (run "musicsync auth" or use the web panel)'}\n`);
        process.exit(1);
      }
      const summary = await runtime.engine().runSync();
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return undefined;
    }

    case 'status': {
      const runtime = runtimeOrExit();
      process.stdout.write(`${JSON.stringify(runtime.overview(), null, 2)}\n`);
      return undefined;
    }

    default:
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

run().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
