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
    mockStore.get.mockImplementation((key: string) => {
      if (key === "fal_key") return Promise.resolve("fal_test_key");
      return Promise.resolve(null);
    });
    const result = await loadSettings();
    expect(result.falKey).toBe("fal_test_key");
  });

  it("returns empty string when key is not set", async () => {
    mockStore.get.mockResolvedValue(null);
    const result = await loadSettings();
    expect(result.falKey).toBe("");
  });

  it("returns analyticsEnabled from the store", async () => {
    mockStore.get.mockImplementation((key: string) => {
      if (key === "analytics_enabled") return Promise.resolve(true);
      return Promise.resolve(null);
    });
    const result = await loadSettings();
    expect(result.analyticsEnabled).toBe(true);
  });

  it("returns undefined for analyticsEnabled when not yet set", async () => {
    mockStore.get.mockResolvedValue(null);
    const result = await loadSettings();
    expect(result.analyticsEnabled).toBeUndefined();
  });

  it("returns anonymousId from the store", async () => {
    mockStore.get.mockImplementation((key: string) => {
      if (key === "anonymous_id") return Promise.resolve("test-uuid-1234");
      return Promise.resolve(null);
    });
    const result = await loadSettings();
    expect(result.anonymousId).toBe("test-uuid-1234");
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

  it("persists analyticsEnabled when provided", async () => {
    mockStore.set.mockResolvedValue(undefined);
    mockStore.save.mockResolvedValue(undefined);
    await saveSettings({ falKey: "", analyticsEnabled: true, anonymousId: "abc-123" });
    expect(mockStore.set).toHaveBeenCalledWith("analytics_enabled", true);
    expect(mockStore.set).toHaveBeenCalledWith("anonymous_id", "abc-123");
  });

  it("does not write analytics_enabled when undefined", async () => {
    mockStore.set.mockResolvedValue(undefined);
    mockStore.save.mockResolvedValue(undefined);
    await saveSettings({ falKey: "" });
    const calls = (mockStore.set as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0]
    );
    expect(calls).not.toContain("analytics_enabled");
  });

  it("can be called multiple times (cached store path)", async () => {
    mockStore.set.mockResolvedValue(undefined);
    mockStore.save.mockResolvedValue(undefined);
    await saveSettings({ falKey: "first" });
    await saveSettings({ falKey: "second" });
    expect(mockStore.set).toHaveBeenCalledTimes(2);
  });
});
