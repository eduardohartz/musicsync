import fs from 'node:fs';
import path from 'node:path';

/** Read a JSON file, returning `fallback` when missing. A corrupt file is
 * backed up alongside as `<name>.corrupt-<ts>` and `fallback` returned. */
export function readJson(filePath, fallback, logger) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    fs.renameSync(filePath, backup);
    logger?.warn(`corrupt JSON at ${filePath}; backed up to ${backup} and starting fresh`);
    return structuredClone(fallback);
  }
}

/** Write JSON atomically: temp file in the same directory, then rename. */
export function writeJsonAtomic(filePath, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, mode !== undefined ? { mode } : {});
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}
