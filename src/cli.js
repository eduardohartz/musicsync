#!/usr/bin/env node
import { buildContext, main } from './index.js';
import { runAuthBootstrap } from './auth/bootstrap.js';

const USAGE = `musicsync — one-way Spotify↔TIDAL playlist sync

Usage:
  musicsync                 start the scheduled sync service
  musicsync auth            one-time interactive OAuth bootstrap
      --manual              paste redirect URLs instead of a local callback server
      --force               re-authorize even if tokens exist
  musicsync sync-once       run a single sync and exit
  musicsync status          show auth and sync state
`;

async function run() {
  const [cmd, ...flags] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'run':
      return main();

    case 'auth': {
      const { config, logger, tokens, adapters } = buildContext();
      const completed = await runAuthBootstrap({
        config, tokens, adapters, logger,
        manual: flags.includes('--manual'),
        force: flags.includes('--force'),
      });
      if (completed.length > 0) {
        process.stdout.write('\nDone. Start the service with "docker compose up -d" or "npm start".\n');
      }
      return undefined;
    }

    case 'sync-once': {
      const { engine, tokens, logger } = buildContext();
      const log = logger.child('cli');
      for (const svc of ['spotify', 'tidal']) {
        if (!tokens.get(svc)?.refreshToken) {
          log.error(`${svc} is not authorized — run "musicsync auth" first`);
          process.exit(1);
        }
      }
      const summary = await engine.runSync();
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return undefined;
    }

    case 'status': {
      const { adapters, state, tokens } = buildContext();
      const status = {
        spotify: adapters.spotify.describeAuth(),
        tidal: adapters.tidal.describeAuth(),
        tokensFile: tokens.file,
        runCount: state.data.runCount,
        pairs: state.data.pairs,
        cachedMappings: Object.keys(state.data.mappings).length,
        unmatchedCached: Object.keys(state.data.failures).length,
      };
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
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
