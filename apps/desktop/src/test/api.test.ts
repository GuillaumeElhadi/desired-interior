import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { checkHealth, getApiBaseUrl } from "../lib/api";

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
