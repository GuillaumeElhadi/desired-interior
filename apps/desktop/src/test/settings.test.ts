import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — use vi.hoisted to initialize shared mock objects.
const { mockStore } = vi.hoisted(() => {
  const mockStore = {
    get: vi.fn(),
    set: vi.fn(),
    save: vi.fn(),
  };
  return { mockStore };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: vi.fn().mockResolvedValue(mockStore),
  },
}));

import { loadSettings, saveSettings } from "../lib/settings";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadSettings", () => {
  it("returns falKey from the store", async () => {
    mockStore.get.mockResolvedValue("fal_test_key");
    const result = await loadSettings();
    expect(result.falKey).toBe("fal_test_key");
  });

  it("returns empty string when key is not set", async () => {
    mockStore.get.mockResolvedValue(null);
    const result = await loadSettings();
    expect(result.falKey).toBe("");
  });
});

describe("saveSettings", () => {
  it("sets fal_key and saves the store", async () => {
    mockStore.set.mockResolvedValue(undefined);
    mockStore.save.mockResolvedValue(undefined);
    await saveSettings({ falKey: "fal_abc" });
    expect(mockStore.set).toHaveBeenCalledWith("fal_key", "fal_abc");
    expect(mockStore.save).toHaveBeenCalledTimes(1);
  });

  it("can be called multiple times (cached store path)", async () => {
    mockStore.set.mockResolvedValue(undefined);
    mockStore.save.mockResolvedValue(undefined);
    await saveSettings({ falKey: "first" });
    await saveSettings({ falKey: "second" });
    expect(mockStore.set).toHaveBeenCalledTimes(2);
  });
});
