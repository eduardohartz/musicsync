import { AuthRequiredError } from './http.js';
import { computeWriteStrategy } from './diff.js';

/**
 * One-way sync engine, direction-agnostic: `master` and `slave` are platform
 * adapters. The slave playlist is fully tool-owned — manual edits to it are
 * overwritten. A failure in one pair never stops the others; AuthRequiredError
 * propagates so the service can enter its re-auth state.
 */
export function createSyncEngine({ config, master, slave, state, matcher, logger }) {
  const log = logger.child('sync');

  async function resolvePairs() {
    if (config.sync.pairs !== 'all') return config.sync.pairs;
    const all = await master.listOwnPlaylists();
    return all.map((p) => ({ masterId: p.id, slaveId: null }));
  }

  async function syncPair({ masterId, slaveId }, unmatchedAll) {
    const pairState = (state.data.pairs[masterId] ??= {});
    if (slaveId) pairState.slavePlaylistId = slaveId;

    const masterMeta = await master.getPlaylistMeta(masterId);

    let created = false;
    if (!pairState.slavePlaylistId) {
      if (config.sync.dryRun) {
        log.info('[dry-run] would create slave playlist', { masterId, name: masterMeta.name });
        return { masterId, slaveId: null, status: 'dry-run', matched: 0, unmatched: 0 };
      }
      const newPlaylist = await slave.createPlaylist({
        name: masterMeta.name,
        description: `Synced from ${config.sync.master} by musicsync — do not edit; changes are overwritten.`,
      });
      pairState.slavePlaylistId = newPlaylist.id;
      created = true;
      log.info('created slave playlist', { masterId, slaveId: newPlaylist.id, name: masterMeta.name });
    }

    const slaveMeta = created ? null : await slave.getPlaylistMeta(pairState.slavePlaylistId);
    const unchanged = !created
      && pairState.masterChangeToken === masterMeta.changeToken
      && pairState.slaveChangeToken === slaveMeta.changeToken;
    // Re-attempt pairs with unmatched tracks so newly-added catalog entries
    // can resolve old misses (matcher's failure cache paces the API cost).
    if (unchanged && (pairState.unmatchedCount ?? 0) === 0) {
      log.debug('unchanged, skipping', { masterId });
      return { masterId, slaveId: pairState.slavePlaylistId, status: 'skipped', matched: 0, unmatched: 0 };
    }

    // Local files (no ISRC, not addable via API) and videos cannot sync.
    const masterItems = (await master.getPlaylistItems(masterId)).filter((t) => !t.isLocal && !t.isVideo);
    const target = [];
    const unmatched = [];
    for (const track of masterItems) {
      const result = await matcher.matchTrack(config.sync.master, track);
      if (result.slaveTrackId) {
        target.push(result.slaveTrackId);
      } else {
        unmatched.push({
          playlist: masterMeta.name,
          masterTrackId: track.id,
          title: track.title,
          artists: track.artists,
          isrc: track.isrc,
          reason: result.reason,
        });
      }
    }

    const currentItems = created ? [] : await slave.getPlaylistItems(pairState.slavePlaylistId);

    if (config.sync.dryRun) {
      const strategy = computeWriteStrategy(target, currentItems.map((t) => t.id));
      log.info('[dry-run] diff computed', {
        masterId, slaveId: pairState.slavePlaylistId,
        strategy: strategy.type, targetLength: target.length, currentLength: currentItems.length,
        unmatched: unmatched.length,
      });
    } else {
      const writeResult = await slave.setPlaylistItems(pairState.slavePlaylistId, target, currentItems);
      if ((writeResult?.dropped ?? 0) > 0) {
        // Partial write: leave the change tokens stale so the next run
        // re-diffs and repairs instead of short-circuiting over the loss.
        log.warn('write incomplete — will re-attempt next run', {
          masterId, slaveId: pairState.slavePlaylistId, dropped: writeResult.dropped,
        });
      } else {
        pairState.masterChangeToken = masterMeta.changeToken;
        pairState.slaveChangeToken = (await slave.getPlaylistMeta(pairState.slavePlaylistId)).changeToken;
        pairState.unmatchedCount = unmatched.length;
        pairState.lastSyncedAt = new Date().toISOString();
      }
    }

    unmatchedAll.push(...unmatched);
    log.info('pair synced', {
      masterId, slaveId: pairState.slavePlaylistId,
      tracks: masterItems.length, matched: target.length, unmatched: unmatched.length,
      dryRun: config.sync.dryRun || undefined,
    });
    return {
      masterId, slaveId: pairState.slavePlaylistId,
      status: config.sync.dryRun ? 'dry-run' : 'synced',
      matched: target.length, unmatched: unmatched.length,
    };
  }

  return {
    async runSync() {
      state.data.runCount += 1;
      const pairs = await resolvePairs();
      const results = [];
      const unmatchedAll = [];
      for (const pair of pairs) {
        try {
          results.push(await syncPair(pair, unmatchedAll));
        } catch (err) {
          if (err instanceof AuthRequiredError) throw err;
          log.error('pair failed', { masterId: pair.masterId, error: String(err) });
          results.push({ masterId: pair.masterId, status: 'failed', error: String(err) });
        }
        state.save();
      }
      state.writeUnmatchedReport(unmatchedAll);
      const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
      log.info('run complete', { run: state.data.runCount, pairs: results.length, ...counts, unmatched: unmatchedAll.length });
      return { pairs: results, unmatchedTotal: unmatchedAll.length };
    },
  };
}
