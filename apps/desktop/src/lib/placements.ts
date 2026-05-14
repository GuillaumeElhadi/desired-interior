import type { PlacementRecord } from "./db";

const DUPLICATE_OFFSET = 24;

/**
 * Returns a new PlacementRecord copied from `source`, offset by 24 px on both
 * axes. The caller is responsible for persisting the result via `savePlacement`.
 *
 * Cascades correctly: duplicating a duplicate shifts by another 24 px, so
 * repeated Cmd+D produces non-overlapping placements.
 */
export function duplicatePlacement(source: PlacementRecord): PlacementRecord {
  return {
    ...source,
    id: crypto.randomUUID(),
    x: source.x + DUPLICATE_OFFSET,
    y: source.y + DUPLICATE_OFFSET,
    updated_at: Date.now(),
  };
}
