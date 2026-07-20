#!/usr/bin/env node
// Docker HEALTHCHECK probe: exit 0 when the service heartbeat is fresh.
import { readHealth, evaluateHealth } from './src/health.js';

const configDir = process.env.CONFIG_DIR ?? '/config';
const result = evaluateHealth(readHealth(configDir));
if (!result.healthy) {
  process.stderr.write(`unhealthy: ${result.reason}\n`);
  process.exit(1);
}
process.exit(0);
