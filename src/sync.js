import { AuthRequiredError } from './http.js';
import { computeWriteStrategy } from './diff.js';
import { computeTwoWayOps } from './twoway.js';
import { LIKED_SONGS_ID } from './platforms/spotify.js';

const other = (platform) => (platform === 'spotify' ? 'tidal' : 'spotify');
const playlistField = (platform) => `${platform}PlaylistId`;
const tokenField = (platform) => `${platform}ChangeToken`;

/**
 * Sync engine over both platform adapters.
 *
 * one-way: the source platform's playlist is the truth; the mirror playlist
 * on the other platform is fully tool-owned (order preserved, edits there
 * are overwritten).
 *
 * two-way: linked playlists; adds/removals propagate both ways with set
 * semantics against a persisted baseline (see twoway.js). No ordering
 * guarantees; each platform keeps its own arrangement.
 *
 * A failure in one pair never stops the others; AuthRequiredError propagates
 * so the service can enter its re-auth state.
 */
export function createSyncEngine({
  config, adapters, state, matcher, logger,
  // Optional live-progress sink (web panel); every hook is fire-and-forget.
  progress = { runStart() {}, update() {}, runEnd() {} },
}) {
  const log = logger.child('sync');
  const syncable = (t) => !t.isLocal && !t.isVideo;

  // The "primary" platform is where configured playlist ids live:
  // the source in one-way mode, Spotify in two-way mode.
  const primaryPlatform = config.sync.mode === 'one-way' ? config.sync.source : 'spotify';

  async function resolvePairs() {
    const base = config.sync.pairs === 'all'
      ? (await adapters[primaryPlatform].listOwnPlaylists()).map((p) => ({ primaryId: p.id, secondaryId: null, name: p.name }))
      : [...config.sync.pairs];
    if (config.sync.likedSongs) {
      // Liked Songs is a virtual Spotify playlist mirrored one-way into
      // TIDAL, regardless of the main mode/source.
      base.push({ primaryId: LIKED_SONGS_ID, secondaryId: null, name: config.sync.likedSongsName, liked: true });
    }
    return base;
  }

  function pairState(primaryId, secondaryId, platform = primaryPlatform) {
    const ps = (state.data.pairs[primaryId] ??= {});
    ps[playlistField(platform)] = primaryId;
    const counterpartField = playlistField(other(platform));
    if (secondaryId) {
      // Re-pointing a pair at a different counterpart playlist invalidates
      // everything learned about the old one: diffing the stale baseline
      // against the new playlist would read as mass removals on both sides.
      if (ps[counterpartField] && ps[counterpartField] !== secondaryId) {
        log.warn('pair re-pointed to a new playlist — resetting baseline and change tokens', {
          primaryId, from: ps[counterpartField], to: secondaryId,
        });
        delete ps.baseline;
        delete ps.spotifyChangeToken;
        delete ps.tidalChangeToken;
      }
      ps[counterpartField] = secondaryId;
    }
    return ps;
  }

  function finishPair(ps, name, result) {
    ps.name = name;
    ps.lastResult = { ...result, at: new Date().toISOString() };
    return result;
  }

  // ---------------------------------------------------------------- one-way
  async function syncPairOneWay(pair, unmatchedAll) {
    const { primaryId, secondaryId } = pair;
    // The Liked Songs pair is always spotify→tidal, whatever the main config.
    const sourcePlatform = pair.liked ? 'spotify' : config.sync.source;
    const mirrorPlatform = other(sourcePlatform);
    const source = adapters[sourcePlatform];
    const mirror = adapters[mirrorPlatform];
    const ps = pairState(primaryId, secondaryId, sourcePlatform);

    const sourceMeta = await source.getPlaylistMeta(primaryId);
    ps.name = sourceMeta.name; // persist early so a failed pair still shows its name
    progress.update(primaryId, { name: sourceMeta.name, status: 'syncing' });

    let created = false;
    if (!ps[playlistField(mirrorPlatform)]) {
      if (config.sync.dryRun) {
        log.info('[dry-run] would create mirror playlist', { primaryId, name: sourceMeta.name });
        return finishPair(ps, sourceMeta.name, { status: 'dry-run', matched: 0, total: 0, unmatched: 0 });
      }
      const newPlaylist = await mirror.createPlaylist({
        name: sourceMeta.name,
        description: `Synced from ${sourcePlatform} by musicsync — do not edit; changes are overwritten.`,
      });
      ps[playlistField(mirrorPlatform)] = newPlaylist.id;
      created = true;
      log.info('created mirror playlist', { primaryId, mirrorId: newPlaylist.id, name: sourceMeta.name });
    }
    const mirrorId = ps[playlistField(mirrorPlatform)];

    const mirrorMeta = created ? null : await mirror.getPlaylistMeta(mirrorId);

    // Liked Songs mirror is renameable from the panel; follow the setting.
    if (pair.liked && mirrorMeta && mirrorMeta.name !== sourceMeta.name) {
      await mirror.updatePlaylist(mirrorId, { name: sourceMeta.name });
      log.info('renamed liked-songs mirror', { mirrorId, from: mirrorMeta.name, to: sourceMeta.name });
    }

    const unchanged = !created
      && ps[tokenField(sourcePlatform)] === sourceMeta.changeToken
      && ps[tokenField(mirrorPlatform)] === mirrorMeta.changeToken;
    // Re-attempt pairs with unmatched tracks so newly-added catalog entries
    // can resolve old misses (matcher's failure cache paces the API cost).
    if (unchanged && (ps.unmatchedCount ?? 0) === 0) {
      log.debug('unchanged, skipping', { primaryId });
      return { status: 'skipped' };
    }

    const sourceItems = (await source.getPlaylistItems(primaryId)).filter(syncable);
    progress.update(primaryId, { total: sourceItems.length });
    const target = [];
    const unmatched = [];
    for (const track of sourceItems) {
      const result = await matcher.matchTrack(track, sourcePlatform, mirrorPlatform);
      if (result.matchedId) {
        target.push(result.matchedId);
      } else {
        unmatched.push({
          playlist: sourceMeta.name,
          platform: sourcePlatform,
          trackId: track.id,
          title: track.title,
          artists: track.artists,
          isrc: track.isrc,
          reason: result.reason,
        });
      }
      progress.update(primaryId, { matched: target.length, unmatched: unmatched.length });
    }

    const currentItems = created ? [] : await mirror.getPlaylistItems(mirrorId);

    if (config.sync.dryRun) {
      const strategy = computeWriteStrategy(target, currentItems.map((t) => t.id));
      log.info('[dry-run] diff computed', {
        primaryId, mirrorId, strategy: strategy.type,
        targetLength: target.length, currentLength: currentItems.length, unmatched: unmatched.length,
      });
      unmatchedAll.push(...unmatched);
      return finishPair(ps, sourceMeta.name, {
        status: 'dry-run', matched: target.length, total: sourceItems.length, unmatched: unmatched.length,
      });
    }

    const writeResult = await mirror.setPlaylistItems(mirrorId, target, currentItems);
    if ((writeResult?.dropped ?? 0) > 0) {
      // Partial write: leave the change tokens stale so the next run
      // re-diffs and repairs instead of short-circuiting over the loss.
      log.warn('write incomplete — will re-attempt next run', { primaryId, mirrorId, dropped: writeResult.dropped });
    } else {
      ps[tokenField(sourcePlatform)] = sourceMeta.changeToken;
      ps[tokenField(mirrorPlatform)] = (await mirror.getPlaylistMeta(mirrorId)).changeToken;
      ps.unmatchedCount = unmatched.length;
      ps.lastSyncedAt = new Date().toISOString();
    }

    unmatchedAll.push(...unmatched);
    log.info('pair synced', {
      primaryId, mirrorId, tracks: sourceItems.length, matched: target.length, unmatched: unmatched.length,
    });
    return finishPair(ps, sourceMeta.name, {
      status: 'synced', matched: target.length, total: sourceItems.length, unmatched: unmatched.length,
    });
  }

  // ---------------------------------------------------------------- two-way
  /**
   * Match one side's new tracks against the other. `covered` holds the ids
   * already consumed by a baseline pair or a pair formed this run — on BOTH
   * platforms. Skipping covered ids on either side keeps every id in at most
   * one pair; a duplicated id in the baseline would later read as a removal
   * of a track the user still wants.
   */
  async function matchNewTracks({ ids, byId, fromPlatform, presentOnTarget, covered, pairs, adds, unmatched, playlistName, onTick }) {
    const toPlatform = other(fromPlatform);
    for (const id of ids) {
      if (covered[fromPlatform].has(id)) continue; // already in a pair formed from the other side
      const track = byId.get(id);
      const result = await matcher.matchTrack(track, fromPlatform, toPlatform);
      if (!result.matchedId) {
        unmatched.push({
          playlist: playlistName, platform: fromPlatform, trackId: id,
          title: track.title, artists: track.artists, isrc: track.isrc, reason: result.reason,
        });
        onTick?.();
        continue;
      }
      if (covered[toPlatform].has(result.matchedId)) continue; // counterpart already paired
      covered[fromPlatform].add(id);
      covered[toPlatform].add(result.matchedId);
      const pair = fromPlatform === 'spotify'
        ? { spotify: id, tidal: result.matchedId }
        : { spotify: result.matchedId, tidal: id };
      if (presentOnTarget.has(result.matchedId)) {
        pairs.push(pair); // both sides already have it
      } else {
        adds.push(pair);
      }
      onTick?.();
    }
  }

  async function syncPairTwoWay({ primaryId, secondaryId }, unmatchedAll) {
    const { spotify, tidal } = adapters;
    const ps = pairState(primaryId, secondaryId); // primary = spotify in two-way

    const spotifyMeta = await spotify.getPlaylistMeta(ps.spotifyPlaylistId);
    ps.name = spotifyMeta.name; // persist early so a failed pair still shows its name
    progress.update(primaryId, { name: spotifyMeta.name, status: 'syncing' });

    if (!ps.tidalPlaylistId) {
      if (config.sync.dryRun) {
        log.info('[dry-run] would create linked tidal playlist', { primaryId, name: spotifyMeta.name });
        return finishPair(ps, spotifyMeta.name, { status: 'dry-run', matched: 0, total: 0, unmatched: 0 });
      }
      const created = await tidal.createPlaylist({
        name: spotifyMeta.name,
        description: 'Linked with Spotify by musicsync (two-way).',
      });
      ps.tidalPlaylistId = created.id;
      log.info('created linked tidal playlist', { primaryId, tidalId: created.id, name: spotifyMeta.name });
    }

    const tidalMeta = await tidal.getPlaylistMeta(ps.tidalPlaylistId);
    const unchanged = ps.spotifyChangeToken === spotifyMeta.changeToken
      && ps.tidalChangeToken === tidalMeta.changeToken;
    if (unchanged && (ps.unmatchedCount ?? 0) === 0 && ps.baseline) {
      log.debug('unchanged, skipping', { primaryId });
      return { status: 'skipped' };
    }

    const spotifyItems = (await spotify.getPlaylistItems(ps.spotifyPlaylistId)).filter(syncable);
    const tidalItems = (await tidal.getPlaylistItems(ps.tidalPlaylistId)).filter(syncable);
    const spotifyById = new Map(spotifyItems.map((t) => [t.id, t]));
    const tidalById = new Map(tidalItems.map((t) => [t.id, t]));
    const spotifyIds = [...spotifyById.keys()];
    const tidalIds = [...tidalById.keys()];

    const ops = computeTwoWayOps({ baseline: ps.baseline ?? [], spotifyIds, tidalIds });
    const firstRun = !ps.baseline;

    const pairs = [...ops.keep];
    const addPairsToTidal = [];
    const addPairsToSpotify = [];
    const unmatched = [];
    const covered = {
      spotify: new Set(pairs.map((p) => p.spotify)),
      tidal: new Set(pairs.map((p) => p.tidal)),
    };

    // Upper-bound total for live progress (covered-set dedupe may shrink it).
    progress.update(primaryId, {
      total: ops.keep.length + ops.newOnSpotify.length + ops.newOnTidal.length,
      matched: pairs.length,
    });
    const tick = () => progress.update(primaryId, {
      matched: pairs.length + addPairsToTidal.length + addPairsToSpotify.length,
      unmatched: unmatched.length,
    });

    await matchNewTracks({
      ids: ops.newOnSpotify, byId: spotifyById, fromPlatform: 'spotify',
      presentOnTarget: new Set(tidalIds), covered,
      pairs, adds: addPairsToTidal, unmatched, playlistName: spotifyMeta.name, onTick: tick,
    });
    await matchNewTracks({
      ids: ops.newOnTidal, byId: tidalById, fromPlatform: 'tidal',
      presentOnTarget: new Set(spotifyIds), covered,
      pairs, adds: addPairsToSpotify, unmatched, playlistName: spotifyMeta.name, onTick: tick,
    });

    // First run has no baseline: merge only — everything is "new", nothing
    // is removed. On later runs, rescue removals whose counterpart id was
    // claimed by a pair formed THIS run: with shared-ISRC duplicates, the
    // deleted copy's counterpart may still be wanted by a surviving track,
    // and removing it would cascade into deleting the track everywhere.
    const wanted = {
      spotify: new Set([...pairs, ...addPairsToTidal, ...addPairsToSpotify].map((p) => p.spotify)),
      tidal: new Set([...pairs, ...addPairsToTidal, ...addPairsToSpotify].map((p) => p.tidal)),
    };
    const removeFromSpotify = firstRun ? [] : ops.removeFromSpotify.filter((p) => !wanted.spotify.has(p.spotify));
    const removeFromTidal = firstRun ? [] : ops.removeFromTidal.filter((p) => !wanted.tidal.has(p.tidal));

    if (config.sync.dryRun) {
      log.info('[dry-run] two-way plan', {
        primaryId, addToTidal: addPairsToTidal.length, addToSpotify: addPairsToSpotify.length,
        removeFromSpotify: removeFromSpotify.length, removeFromTidal: removeFromTidal.length,
        unmatched: unmatched.length, firstRun,
      });
      unmatchedAll.push(...unmatched);
      return finishPair(ps, spotifyMeta.name, {
        status: 'dry-run', matched: pairs.length, total: pairs.length + unmatched.length, unmatched: unmatched.length,
      });
    }

    let droppedAdds = 0;
    if (removeFromSpotify.length > 0) {
      // snapshot_id pins the removal to the state the diff was computed
      // from, so a track the user re-adds mid-run survives.
      await spotify.removeTracks(
        ps.spotifyPlaylistId,
        removeFromSpotify.map((p) => ({ id: p.spotify })),
        { snapshotId: spotifyMeta.changeToken },
      );
      log.info('removed from spotify (removed on tidal)', { primaryId, count: removeFromSpotify.length });
    }
    if (removeFromTidal.length > 0) {
      await tidal.removeTracks(
        ps.tidalPlaylistId,
        removeFromTidal.map((p) => ({ id: p.tidal, itemId: tidalById.get(p.tidal)?.itemId })),
      );
      log.info('removed from tidal (removed on spotify)', { primaryId, count: removeFromTidal.length });
    }
    if (addPairsToTidal.length > 0) {
      const { absent } = await tidal.addTracks(ps.tidalPlaylistId, addPairsToTidal.map((p) => p.tidal));
      const absentSet = new Set(absent);
      droppedAdds = absent.length;
      // Only pairs whose add actually landed enter the baseline — a pair
      // recorded without its track present would read as a removal next run.
      pairs.push(...addPairsToTidal.filter((p) => !absentSet.has(p.tidal)));
      log.info('added to tidal', { primaryId, count: addPairsToTidal.length - absent.length, dropped: absent.length || undefined });
    }
    if (addPairsToSpotify.length > 0) {
      await spotify.addTracks(ps.spotifyPlaylistId, addPairsToSpotify.map((p) => p.spotify));
      pairs.push(...addPairsToSpotify);
      log.info('added to spotify', { primaryId, count: addPairsToSpotify.length });
    }

    ps.baseline = pairs;
    // Change-token rule: a token may only be persisted if it provably covers
    // everything this run diffed. For an untouched platform that is the
    // PRE-read token (a mid-run user edit then re-diffs next run). For a
    // platform we wrote to — or where adds were dropped — no such token
    // exists, so leave it stale: the next run re-diffs and converges, at the
    // cost of exactly one extra diff pass after each writing run.
    const wroteSpotify = removeFromSpotify.length > 0 || addPairsToSpotify.length > 0;
    const wroteTidal = removeFromTidal.length > 0 || addPairsToTidal.length > 0;
    if (wroteSpotify) delete ps.spotifyChangeToken;
    else ps.spotifyChangeToken = spotifyMeta.changeToken;
    if (wroteTidal || droppedAdds > 0) delete ps.tidalChangeToken;
    else ps.tidalChangeToken = tidalMeta.changeToken;
    ps.unmatchedCount = unmatched.length;
    ps.lastSyncedAt = new Date().toISOString();

    unmatchedAll.push(...unmatched);
    log.info('pair synced (two-way)', {
      primaryId, tidalId: ps.tidalPlaylistId, inSync: pairs.length,
      addedToTidal: addPairsToTidal.length, addedToSpotify: addPairsToSpotify.length,
      removed: removeFromSpotify.length + removeFromTidal.length, unmatched: unmatched.length,
    });
    return finishPair(ps, spotifyMeta.name, {
      status: 'synced', matched: pairs.length, total: pairs.length + unmatched.length, unmatched: unmatched.length,
    });
  }

  // ------------------------------------------------------------------- run
  return {
    async runSync() {
      state.data.runCount += 1;
      const pairs = await resolvePairs();
      // Per-pair dispatch: the liked pair is one-way even in two-way mode.
      const syncPairFor = (pair) => (config.sync.mode === 'two-way' && !pair.liked ? syncPairTwoWay : syncPairOneWay);
      // Seed the live view with every pair up front so the panel shows the
      // whole queue immediately, not one playlist at a time.
      progress.runStart(pairs.map((p) => ({
        primaryId: p.primaryId,
        name: p.name ?? state.data.pairs[p.primaryId]?.name ?? null,
      })));
      const results = [];
      const unmatchedAll = [];
      try {
        for (const pair of pairs) {
          try {
            const result = await syncPairFor(pair)(pair, unmatchedAll);
            progress.update(pair.primaryId, { status: result.status, matched: result.matched ?? 0, unmatched: result.unmatched ?? 0 });
            results.push({ primaryId: pair.primaryId, ...result });
          } catch (err) {
            if (err instanceof AuthRequiredError) throw err;
            log.error('pair failed', { primaryId: pair.primaryId, error: String(err) });
            progress.update(pair.primaryId, { status: 'failed' });
            const ps = state.data.pairs[pair.primaryId];
            if (ps) ps.lastResult = { status: 'failed', error: String(err), at: new Date().toISOString() };
            results.push({ primaryId: pair.primaryId, status: 'failed', error: String(err) });
          }
          state.save();
        }
      } finally {
        progress.runEnd();
      }
      state.writeUnmatchedReport(unmatchedAll);
      const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
      log.info('run complete', { run: state.data.runCount, mode: config.sync.mode, pairs: results.length, ...counts, unmatched: unmatchedAll.length });
      return { pairs: results, unmatchedTotal: unmatchedAll.length };
    },
  };
}
