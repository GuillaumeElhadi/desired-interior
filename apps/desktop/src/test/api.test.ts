import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  ApiError,
  checkHealth,
  compose,
  composePreview,
  getApiBaseUrl,
  postLog,
  preprocessScene,
} from "../lib/api";

const mockInvoke = vi.mocked(invoke);

function setupInvokeMocks() {
  mockInvoke.mockImplementation((cmd: unknown) => {
    if (cmd === "api_base_url") return Promise.resolve("http://127.0.0.1:9999");
    if (cmd === "ipc_token") return Promise.resolve("test-token");
    return Promise.reject(new Error(`unknown command: ${String(cmd)}`));
  });
}

/** Build a mock non-ok Response that fromResponse can parse via .text(). */
function errorResponse(status: number, statusText: string, body: object) {
  return {
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
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

  it("throws ApiError on non-ok response", async () => {
    setupInvokeMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        errorResponse(503, "Service Unavailable", {
          error_code: "service_unavailable",
          message: "down",
          request_id: "r1",
        })
      )
    );
    await expect(checkHealth()).rejects.toBeInstanceOf(ApiError);
    await expect(checkHealth()).rejects.toMatchObject({
      errorCode: "service_unavailable",
      httpStatus: 503,
    });
  });

  it("throws ApiError with sidecar_unreachable on network failure", async () => {
    setupInvokeMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    await expect(checkHealth()).rejects.toBeInstanceOf(ApiError);
    await expect(checkHealth()).rejects.toMatchObject({ errorCode: "sidecar_unreachable" });
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

  it("throws ApiError on non-ok response", async () => {
    setupInvokeMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        errorResponse(500, "Internal Server Error", {
          error_code: "internal_server_error",
          message: "boom",
          request_id: "r2",
        })
      )
    );
    await expect(postLog({ entries: [] })).rejects.toBeInstanceOf(ApiError);
    await expect(postLog({ entries: [] })).rejects.toMatchObject({ httpStatus: 500 });
  });
});

describe("compose", () => {
  const COMPOSE_REQUEST = {
    scene_id: "a".repeat(64),
    object_id: "b".repeat(64),
    placement: {
      bbox: { x: 10, y: 20, width: 100, height: 80 },
      depth_hint: 0.5,
      rotation: 0,
    },
    style_hints: { prompt_suffix: "" },
  };

  const COMPOSE_RESPONSE = {
    composition_id: "c".repeat(64),
    image: { url: "https://cdn.fal.ai/result.jpg", content_type: "image/jpeg" },
  };

  it("POSTs JSON to /compose with auth header and returns parsed body", async () => {
    setupInvokeMocks();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(COMPOSE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await compose(COMPOSE_REQUEST);

    expect(result).toEqual(COMPOSE_RESPONSE);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/compose",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(COMPOSE_REQUEST),
      })
    );
  });

  it("threads AbortSignal through to fetch", async () => {
    setupInvokeMocks();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(COMPOSE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const ac = new AbortController();
    await compose(COMPOSE_REQUEST, ac.signal);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: ac.signal })
    );
  });

  it("throws ApiError with fal_timeout on 504", async () => {
    setupInvokeMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        errorResponse(504, "Gateway Timeout", {
          error_code: "fal_timeout",
          message: "timed out",
          request_id: "r3",
        })
      )
    );
    await expect(compose(COMPOSE_REQUEST)).rejects.toBeInstanceOf(ApiError);
    await expect(compose(COMPOSE_REQUEST)).rejects.toMatchObject({
      errorCode: "fal_timeout",
      httpStatus: 504,
    });
  });

  it("throws ApiError with fal_key_missing on 503", async () => {
    setupInvokeMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        errorResponse(503, "Service Unavailable", {
          error_code: "fal_key_missing",
          message: "no key",
          request_id: "r4",
        })
      )
    );
    await expect(compose(COMPOSE_REQUEST)).rejects.toMatchObject({ errorCode: "fal_key_missing" });
  });

  it("throws ApiError with fal_rate_limited on 429", async () => {
    setupInvokeMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        errorResponse(429, "Too Many Requests", {
          error_code: "fal_rate_limited",
          message: "slow down",
          request_id: "r5",
        })
      )
    );
    await expect(compose(COMPOSE_REQUEST)).rejects.toMatchObject({
      errorCode: "fal_rate_limited",
    });
  });
});

describe("composePreview", () => {
  const COMPOSE_REQUEST = {
    scene_id: "a".repeat(64),
    object_id: "b".repeat(64),
    placement: {
      bbox: { x: 10, y: 20, width: 100, height: 80 },
      depth_hint: 0.5,
      rotation: 0,
    },
    style_hints: { prompt_suffix: "" },
  };

  const PREVIEW_RESPONSE = {
    preview_id: "d".repeat(64),
    image: { url: "https://cdn.fal.ai/preview.jpg", content_type: "image/jpeg" },
  };

  it("POSTs JSON to /compose/preview with auth header and returns parsed body", async () => {
    setupInvokeMocks();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(PREVIEW_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await composePreview(COMPOSE_REQUEST);

    expect(result).toEqual(PREVIEW_RESPONSE);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/compose/preview",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(COMPOSE_REQUEST),
      })
    );
  });

  it("threads AbortSignal through to fetch", async () => {
    setupInvokeMocks();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(PREVIEW_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const ac = new AbortController();
    await composePreview(COMPOSE_REQUEST, ac.signal);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: ac.signal })
    );
  });

  it("throws ApiError on non-ok response", async () => {
    setupInvokeMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        errorResponse(504, "Gateway Timeout", {
          error_code: "fal_timeout",
          message: "timed out",
          request_id: "r6",
        })
      )
    );
    await expect(composePreview(COMPOSE_REQUEST)).rejects.toBeInstanceOf(ApiError);
    await expect(composePreview(COMPOSE_REQUEST)).rejects.toMatchObject({ httpStatus: 504 });
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

  it("throws ApiError on non-ok response", async () => {
    setupInvokeMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        errorResponse(502, "Bad Gateway", {
          error_code: "fal_error",
          message: "fal.ai error",
          request_id: "r7",
        })
      )
    );
    const file = new File([], "room.jpg", { type: "image/jpeg" });
    await expect(preprocessScene(file)).rejects.toBeInstanceOf(ApiError);
    await expect(preprocessScene(file)).rejects.toMatchObject({ errorCode: "fal_error" });
  });
});
