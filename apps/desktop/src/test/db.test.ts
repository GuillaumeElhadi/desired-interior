import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectRecord } from "../lib/db";

// Mock tauri-plugin-sql before importing db module
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(),
  },
}));

import Database from "@tauri-apps/plugin-sql";
import { _resetDbForTest, loadObjects, removeObject, renameObject, saveObject } from "../lib/db";

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

describe("getDb singleton", () => {
  it("calls Database.load only once across multiple operations", async () => {
    const mockDb = makeMockDb({ select: vi.fn().mockResolvedValue([]) });
    mockLoad.mockResolvedValue(mockDb);

    await loadObjects("x");
    await loadObjects("x");

    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});
