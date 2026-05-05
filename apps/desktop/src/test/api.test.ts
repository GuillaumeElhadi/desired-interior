import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { checkHealth, getApiBaseUrl } from "../lib/api";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => vi.clearAllMocks());

describe("getApiBaseUrl", () => {
  it("calls invoke with api_base_url", async () => {
    mockInvoke.mockResolvedValue("http://127.0.0.1:9999");
    expect(await getApiBaseUrl()).toBe("http://127.0.0.1:9999");
    expect(mockInvoke).toHaveBeenCalledWith("api_base_url");
  });
});

describe("checkHealth", () => {
  it("fetches /health and returns parsed body", async () => {
    mockInvoke.mockResolvedValue("http://127.0.0.1:9999");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "ok", version: "0.0.0" }),
      })
    );
    expect(await checkHealth()).toEqual({ status: "ok", version: "0.0.0" });
  });

  it("throws on non-ok response", async () => {
    mockInvoke.mockResolvedValue("http://127.0.0.1:9999");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(checkHealth()).rejects.toThrow("health check failed: 503");
  });
});
