import { describe, expect, it } from "vitest";
import type { PlacementRecord } from "../lib/db";
import { duplicatePlacement } from "../lib/placements";

const base: PlacementRecord = {
  id: "abc-123",
  scene_id: "scene-1",
  object_id: "obj-1",
  x: 100,
  y: 200,
  scale_x: 0.5,
  scale_y: 0.75,
  rotation: 45,
  depth_hint: 0.3,
  updated_at: 1000,
};

describe("duplicatePlacement", () => {
  it("generates a new unique id", () => {
    const dup = duplicatePlacement(base);
    expect(dup.id).not.toBe(base.id);
    // UUID v4 pattern
    expect(dup.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("offsets x and y by 24 px", () => {
    const dup = duplicatePlacement(base);
    expect(dup.x).toBe(base.x + 24);
    expect(dup.y).toBe(base.y + 24);
  });

  it("inherits scene_id, object_id, scale, rotation, and depth_hint", () => {
    const dup = duplicatePlacement(base);
    expect(dup.scene_id).toBe(base.scene_id);
    expect(dup.object_id).toBe(base.object_id);
    expect(dup.scale_x).toBe(base.scale_x);
    expect(dup.scale_y).toBe(base.scale_y);
    expect(dup.rotation).toBe(base.rotation);
    expect(dup.depth_hint).toBe(base.depth_hint);
  });

  it("sets a fresh updated_at timestamp", () => {
    const before = Date.now();
    const dup = duplicatePlacement(base);
    const after = Date.now();
    expect(dup.updated_at).toBeGreaterThanOrEqual(before);
    expect(dup.updated_at).toBeLessThanOrEqual(after);
  });

  it("does not mutate the source record", () => {
    const snapshot = { ...base };
    duplicatePlacement(base);
    expect(base).toEqual(snapshot);
  });

  it("cascades: duplicating a duplicate adds another 24 px", () => {
    const dup1 = duplicatePlacement(base);
    const dup2 = duplicatePlacement(dup1);
    expect(dup2.x).toBe(base.x + 48);
    expect(dup2.y).toBe(base.y + 48);
  });

  it("four successive duplications yield four non-overlapping positions", () => {
    const chain = [base];
    for (let i = 0; i < 3; i++) {
      chain.push(duplicatePlacement(chain[chain.length - 1]));
    }
    // All positions are unique
    const coords = chain.map((p) => `${p.x},${p.y}`);
    expect(new Set(coords).size).toBe(4);
    // Each step is exactly 24 px
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].x - chain[i - 1].x).toBe(24);
      expect(chain[i].y - chain[i - 1].y).toBe(24);
    }
  });
});
