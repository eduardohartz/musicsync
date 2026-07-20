import path from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * Panel-managed settings file. ENV seeds defaults; anything written here by
 * the web panel takes precedence for app settings (see config.js merge).
 * Bootstrap vars (PORT, WEB_PANEL_*, CONFIG_DIR, AUTH_*) remain ENV-only.
 */
export function settingsFile(configDir) {
  return path.join(configDir, 'settings.json');
}

export function readSettings(configDir, logger) {
  return readJson(settingsFile(configDir), {}, logger);
}

export function writeSettings(configDir, settings) {
  writeJsonAtomic(settingsFile(configDir), settings, { mode: 0o600 });
  return settings;
}

/** Shallow-merge patch sections into existing settings and persist. */
export function updateSettings(configDir, patch, logger) {
  const current = readSettings(configDir, logger);
  const next = { ...current };
  for (const [section, value] of Object.entries(patch)) {
    next[section] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...current[section], ...value }
      : value;
  }
  return writeSettings(configDir, next);
}
