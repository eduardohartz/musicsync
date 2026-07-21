/**
 * Two-way sync is SET-based: adds and removals propagate in both directions,
 * duplicates collapse, and each platform keeps its own ordering (new tracks
 * append). The baseline is the set of track pairs known to exist on both
 * sides after the last successful run — a three-way diff against it decides
 * what changed where.
 *
 * Removal-wins rule: a baseline pair missing on one side means it was
 * removed there, so it is removed from the other side too. "Removed then
 * re-added elsewhere" is indistinguishable from "untouched" without per-item
 * timestamps; this is documented behavior.
 */
export function computeTwoWayOps({ baseline = [], spotifyIds = [], tidalIds = [] }) {
  const sSet = new Set(spotifyIds);
  const tSet = new Set(tidalIds);
  const keep = [];
  const removeFromSpotify = [];
  const removeFromTidal = [];
  const baseS = new Set();
  const baseT = new Set();

  for (const pair of baseline) {
    baseS.add(pair.spotify);
    baseT.add(pair.tidal);
    const inS = sSet.has(pair.spotify);
    const inT = tSet.has(pair.tidal);
    if (inS && inT) keep.push(pair);
    else if (inS && !inT) removeFromSpotify.push(pair); // removed on TIDAL
    else if (!inS && inT) removeFromTidal.push(pair);   // removed on Spotify
    // gone from both sides: drop silently
  }

  return {
    keep,
    removeFromSpotify,
    removeFromTidal,
    newOnSpotify: [...sSet].filter((id) => !baseS.has(id)),
    newOnTidal: [...tSet].filter((id) => !baseT.has(id)),
  };
}
