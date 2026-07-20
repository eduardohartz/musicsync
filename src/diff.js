/**
 * Decide how to bring a slave playlist (currentIds, in order) to the target
 * sequence (targetIds, in order):
 *  - 'skip'    — already identical
 *  - 'append'  — current is a strict prefix of target; only additions needed
 *  - 'rewrite' — anything else (removals, reorders, replacements)
 */
export function computeWriteStrategy(targetIds, currentIds) {
  if (targetIds.length === currentIds.length && targetIds.every((id, i) => id === currentIds[i])) {
    return { type: 'skip' };
  }
  if (currentIds.length < targetIds.length && currentIds.every((id, i) => id === targetIds[i])) {
    return { type: 'append', toAppend: targetIds.slice(currentIds.length) };
  }
  return { type: 'rewrite' };
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
