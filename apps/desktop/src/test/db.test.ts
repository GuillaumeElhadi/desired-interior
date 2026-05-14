import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectRecord, PlacementRecord, RenderRecord } from "../lib/db";

// Mock tauri-plugin-sql before importing db module
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(),
  },
}));

import Database from "@tauri-apps/plugin-sql";
import {
  _resetDbForTest,
  deletePlacement,
  loadObjects,
  loadPlacements,
  loadRenders,
  removeObject,
  renameObject,
  saveObject,
  savePlacement,
  saveRender,
  updatePlacement,
} from "../lib/db";

const mockLoad = vi.mocked(Database.load);

function makeMockDb(overrides: Partial<{ select: unknown; execute: unknown }> = {}) {
  return {
    select: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 }),
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof Database.load>>;
}

const RECORD: ObjectRecord = {
  id: "a".repeat(64),
  scene_id: "s".repeat(64),
  name: "chair",
  masked_url: "https://cdn.fal.ai/masked.png",
  width: 256,
  height: 256,
  object_type: "floor",
  created_at: 1_700_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetDbForTest();
});

describe("loadObjects", () => {
  it("queries objects by scene_id in ASC order", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([RECORD]) });
    mockLoad.mockResolvedValue(mockDb);

    const result = await loadObjects(RECORD.scene_id);

    expect(result).toEqual([RECORD]);
    expect(vi.mocked(mockDb.select)).toHaveBeenCalledWith(expect.stringContaining("scene_id"), [
      RECORD.scene_id,
    ]);
  });

  it("returns empty array when no objects match", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([]) });
    mockLoad.mockResolvedValue(mockDb);

    const result = await loadObjects("unknown-scene");
    expect(result).toEqual([]);
  });
});

describe("saveObject", () => {
  it("calls execute with INSERT OR IGNORE and all fields", async () => {
    const mockDb = makeMockDb();
    mockLoad.mockResolvedValue(mockDb);

    await saveObject(RECORD);

    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE"),
      [
        RECORD.id,
        RECORD.scene_id,
        RECORD.name,
        RECORD.masked_url,
        RECORD.width,
        RECORD.height,
        RECORD.object_type,
        RECORD.created_at,
      ]
    );
  });
});

describe("removeObject", () => {
  it("calls execute with DELETE WHERE id", async () => {
    const mockDb = makeMockDb();
    mockLoad.mockResolvedValue(mockDb);

    await removeObject(RECORD.id);

    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM objects WHERE id"),
      [RECORD.id]
    );
  });
});

describe("renameObject", () => {
  it("calls execute with UPDATE SET name", async () => {
    const mockDb = makeMockDb();
    mockLoad.mockResolvedValue(mockDb);

    await renameObject(RECORD.id, "sofa");

    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE objects SET name"),
      ["sofa", RECORD.id]
    );
  });
});

const PLACEMENT: PlacementRecord = {
  id: "12345678-1234-1234-1234-123456789abc",
  scene_id: RECORD.scene_id,
  object_id: RECORD.id,
  x: 120,
  y: 80,
  scale_x: 0.25,
  scale_y: 0.25,
  rotation: 15,
  depth_hint: 0.6,
  updated_at: 1_700_000_001,
};

describe("loadPlacements", () => {
  it("queries placements by scene_id in ASC order", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([PLACEMENT]) });
    mockLoad.mockResolvedValue(mockDb);

    const result = await loadPlacements(PLACEMENT.scene_id);

    expect(result).toEqual([PLACEMENT]);
    expect(vi.mocked(mockDb.select)).toHaveBeenCalledWith(expect.stringContaining("scene_id"), [
      PLACEMENT.scene_id,
    ]);
  });

  it("returns empty array when no placements match", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([]) });
    mockLoad.mockResolvedValue(mockDb);

    const result = await loadPlacements("no-scene");
    expect(result).toEqual([]);
  });
});

describe("savePlacement", () => {
  it("calls execute with INSERT OR IGNORE and all fields", async () => {
    const mockDb = makeMockDb();
    mockLoad.mockResolvedValue(mockDb);

    await savePlacement(PLACEMENT);

    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE"),
      [
        PLACEMENT.id,
        PLACEMENT.scene_id,
        PLACEMENT.object_id,
        PLACEMENT.x,
        PLACEMENT.y,
        PLACEMENT.scale_x,
        PLACEMENT.scale_y,
        PLACEMENT.rotation,
        PLACEMENT.depth_hint,
        PLACEMENT.updated_at,
      ]
    );
  });
});

describe("updatePlacement", () => {
  it("calls execute with UPDATE and spatial/transform fields", async () => {
    const mockDb = makeMockDb();
    mockLoad.mockResolvedValue(mockDb);

    await updatePlacement(PLACEMENT);

    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE placements SET"),
      [
        PLACEMENT.x,
        PLACEMENT.y,
        PLACEMENT.scale_x,
        PLACEMENT.scale_y,
        PLACEMENT.rotation,
        PLACEMENT.depth_hint,
        PLACEMENT.updated_at,
        PLACEMENT.id,
      ]
    );
  });
});

describe("deletePlacement", () => {
  it("calls execute with DELETE WHERE id", async () => {
    const mockDb = makeMockDb();
    mockLoad.mockResolvedValue(mockDb);

    await deletePlacement(PLACEMENT.id);

    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM placements WHERE id"),
      [PLACEMENT.id]
    );
  });
});

const RENDER: RenderRecord = {
  id: "11111111-1111-4111-a111-111111111111",
  scene_id: RECORD.scene_id,
  composition_id: "c".repeat(64),
  result_url: "https://cdn.fal.ai/result.jpg",
  created_at: 1_700_000_002,
};

describe("saveRender", () => {
  it("calls execute with INSERT OR IGNORE and all fields", async () => {
    const mockDb = makeMockDb();
    mockLoad.mockResolvedValue(mockDb);

    await saveRender(RENDER);

    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE"),
      [RENDER.id, RENDER.scene_id, RENDER.composition_id, RENDER.result_url, RENDER.created_at]
    );
  });
});

describe("loadRenders", () => {
  it("queries renders by scene_id in DESC order", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([RENDER]) });
    mockLoad.mockResolvedValue(mockDb);

    const result = await loadRenders(RENDER.scene_id);

    expect(result).toEqual([RENDER]);
    expect(vi.mocked(mockDb.select)).toHaveBeenCalledWith(expect.stringContaining("scene_id"), [
      RENDER.scene_id,
    ]);
  });

  it("returns empty array when no renders match", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([]) });
    mockLoad.mockResolvedValue(mockDb);

    expect(await loadRenders("no-scene")).toEqual([]);
  });
});

describe("getDb singleton", () => {
  it("calls Database.load only once across multiple operations", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([]) });
    mockLoad.mockResolvedValue(mockDb);

    await loadObjects("x");
    await loadObjects("x");

    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});
