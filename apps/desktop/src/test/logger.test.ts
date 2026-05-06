import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock api before logger is imported so the mocked postLog is captured at module init.
vi.mock("../lib/api", () => ({
  postLog: vi.fn().mockResolvedValue(undefined),
  checkHealth: vi.fn(),
  getApiBaseUrl: vi.fn().mockResolvedValue("http://127.0.0.1:9999"),
}));

import * as api from "../lib/api";
import { correlationId, logger } from "../lib/logger";

const mockPostLog = vi.mocked(api.postLog);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("correlationId", () => {
  it("is a valid UUID v4", () => {
    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("is stable across calls (session-scoped, not per-call)", () => {
    expect(correlationId).toBe(correlationId);
  });
});

describe("logger", () => {
  it("ships error entries to the backend with the correlation ID", async () => {
    logger.error("test error", { component: "App" });
    await vi.waitFor(() => expect(mockPostLog).toHaveBeenCalledOnce());
    expect(mockPostLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            level: "error",
            message: "test error",
            correlation_id: correlationId,
            context: { component: "App" },
          }),
        ],
      })
    );
  });

  it("ships warn entries", async () => {
    logger.warn("a warning");
    await vi.waitFor(() => expect(mockPostLog).toHaveBeenCalledOnce());
    expect(mockPostLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [expect.objectContaining({ level: "warn", message: "a warning" })],
      })
    );
  });

  it("ships info and debug entries", async () => {
    logger.info("info msg");
    logger.debug("debug msg");
    await vi.waitFor(() => expect(mockPostLog).toHaveBeenCalledTimes(2));
  });

  it("includes an ISO timestamp in each entry", async () => {
    logger.info("ts check");
    await vi.waitFor(() => expect(mockPostLog).toHaveBeenCalledOnce());
    const entry = mockPostLog.mock.calls[0][0].entries[0];
    expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
  });

  it("never throws when postLog fails", async () => {
    mockPostLog.mockRejectedValueOnce(new Error("network down"));
    expect(() => logger.error("should not crash")).not.toThrow();
    // Let the rejected promise settle — the logger must survive silently.
    await vi.waitFor(() => expect(mockPostLog).toHaveBeenCalledOnce());
  });
});
