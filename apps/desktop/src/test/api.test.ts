import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { checkHealth, getApiBaseUrl, postLog, preprocessScene } from "../lib/api";

const mockInvoke = vi.mocked(invoke);

function setupInvokeMocks() {
  mockInvoke.mockImplementation((cmd: unknown) => {
    if (cmd === "api_base_url") return Promise.resolve("http://127.0.0.1:9999");
    if (cmd === "ipc_token") return Promise.resolve("test-token");
    return Promise.reject(new Error(`unknown command: ${String(cmd)}`));
  });
}

beforeEach(() => vi.clearAllMocks());

describe("getApiBaseUrl", () => {
  it("calls invoke with api_base_url", async () => {
    mockInvoke.mockResolvedValue("http://127.0.0.1:9999");
    expect(await getApiBaseUrl()).toBe("http://127.0.0.1:9999");
    expect(mockInvoke).toHaveBeenCalledWith("api_base_url");
  });
});

describe("checkHealth", () => {
  it("fetches /health with auth header and returns parsed body", async () => {
    setupInvokeMocks();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "ok", version: "0.0.0" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    expect(await checkHealth()).toEqual({ status: "ok", version: "0.0.0" });
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:9999/health", {
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("throws on non-ok response", async () => {
    setupInvokeMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(checkHealth()).rejects.toThrow("health check failed: 503");
  });
});

describe("postLog", () => {
  it("POSTs to /logs with auth header and JSON body", async () => {
    setupInvokeMocks();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", mockFetch);

    const body = {
      entries: [
        {
          level: "error" as const,
          message: "boom",
          correlation_id: "abc-123",
          timestamp: "2024-01-01T00:00:00Z",
          context: {},
        },
      ],
    };

    await postLog(body);

    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:9999/logs", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("throws on non-ok response", async () => {
    setupInvokeMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(postLog({ entries: [] })).rejects.toThrow("log upload failed: 500");
  });
});

describe("preprocessScene", () => {
  const mockResponse = {
    scene_id: "a".repeat(64),
    depth_map: { url: "https://cdn.fal.ai/depth.png", width: 512, height: 512 },
    masks: [],
    metadata: {
      dominant_surface: "floor",
      lighting_hint: "neutral",
      light_direction: "ambient",
      color_temperature: "neutral",
    },
  };

  it("POSTs multipart form data to /scenes/preprocess with auth header", async () => {
    setupInvokeMocks();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal("fetch", mockFetch);

    const file = new File([new Uint8Array(16)], "room.jpg", { type: "image/jpeg" });
    const result = await preprocessScene(file);

    expect(result).toEqual(mockResponse);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/scenes/preprocess",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
        body: expect.any(FormData),
      })
    );
    const body = mockFetch.mock.calls[0][1].body as FormData;
    expect(body.get("image")).toBe(file);
  });

  it("throws on non-ok response", async () => {
    setupInvokeMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const file = new File([], "room.jpg", { type: "image/jpeg" });
    await expect(preprocessScene(file)).rejects.toThrow("preprocess failed: 502");
  });
});
