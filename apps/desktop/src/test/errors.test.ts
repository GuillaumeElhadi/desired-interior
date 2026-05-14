import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { toUserMessage } from "../lib/errors";

// ---------------------------------------------------------------------------
// ApiError.fromResponse
// ---------------------------------------------------------------------------

describe("ApiError.fromResponse", () => {
  it("parses error_code from JSON body", async () => {
    const response = new Response(
      JSON.stringify({ error_code: "fal_key_missing", message: "no key", request_id: "req-1" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
    const err = await ApiError.fromResponse(response);
    expect(err.errorCode).toBe("fal_key_missing");
    expect(err.httpStatus).toBe(503);
    expect(err.message).toBe("no key");
    expect(err.requestId).toBe("req-1");
  });

  it("falls back to error field when error_code absent", async () => {
    const response = new Response(
      JSON.stringify({ error: "fal_timeout", message: "timed out", request_id: "req-2" }),
      { status: 504, headers: { "Content-Type": "application/json" } }
    );
    const err = await ApiError.fromResponse(response);
    expect(err.errorCode).toBe("fal_timeout");
  });

  it("falls back to status-derived code when JSON has no error fields", async () => {
    const response = new Response(JSON.stringify({ detail: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    const err = await ApiError.fromResponse(response);
    expect(err.errorCode).toBe("not_found");
    expect(err.httpStatus).toBe(404);
  });

  it("falls back to text body when JSON parse fails", async () => {
    const response = new Response("plain error text", { status: 502 });
    const err = await ApiError.fromResponse(response);
    expect(err.errorCode).toBe("bad_gateway");
    expect(err.message).toBe("plain error text");
  });

  it("is an instance of Error", async () => {
    const response = new Response(JSON.stringify({ error_code: "server_error" }), { status: 500 });
    const err = await ApiError.fromResponse(response);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe("ApiError");
  });
});

// ---------------------------------------------------------------------------
// ApiError.fromNetworkError
// ---------------------------------------------------------------------------

describe("ApiError.fromNetworkError", () => {
  it("returns sidecar_unreachable when online", () => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    const err = ApiError.fromNetworkError(new Error("fetch failed"));
    expect(err.errorCode).toBe("sidecar_unreachable");
    expect(err.httpStatus).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toUserMessage
// ---------------------------------------------------------------------------

describe("toUserMessage", () => {
  function makeErr(code: string, status = 500): ApiError {
    return new ApiError(code, status, "raw message");
  }

  it("maps offline to retry CTA", () => {
    const msg = toUserMessage(makeErr("offline", 0));
    expect(msg.cta).toBe("retry");
    expect(msg.title).toMatch(/internet/i);
  });

  it("maps sidecar_unreachable to reload CTA", () => {
    const msg = toUserMessage(makeErr("sidecar_unreachable", 0));
    expect(msg.cta).toBe("reload");
  });

  it("maps fal_key_missing to settings CTA", () => {
    const msg = toUserMessage(makeErr("fal_key_missing", 503));
    expect(msg.cta).toBe("settings");
    expect(msg.title).toMatch(/api key/i);
  });

  it("maps fal_rate_limited to wait CTA", () => {
    const msg = toUserMessage(makeErr("fal_rate_limited", 429));
    expect(msg.cta).toBe("wait");
  });

  it("maps fal_timeout to retry CTA", () => {
    const msg = toUserMessage(makeErr("fal_timeout", 504));
    expect(msg.cta).toBe("retry");
  });

  it("maps fal_error to retry CTA", () => {
    const msg = toUserMessage(makeErr("fal_error", 502));
    expect(msg.cta).toBe("retry");
  });

  it("maps scene_not_found to reload CTA", () => {
    const msg = toUserMessage(makeErr("scene_not_found", 404));
    expect(msg.cta).toBe("reload");
  });

  it("maps scene_original_missing to reload CTA", () => {
    const msg = toUserMessage(makeErr("scene_original_missing", 409));
    expect(msg.cta).toBe("reload");
  });

  it("maps unauthorized to reload CTA", () => {
    const msg = toUserMessage(makeErr("unauthorized", 401));
    expect(msg.cta).toBe("reload");
  });

  it("returns retry for unknown code", () => {
    const msg = toUserMessage(makeErr("totally_unknown_code", 999));
    expect(msg.cta).toBe("retry");
    expect(msg.title).toBeTruthy();
    expect(msg.detail).toBeTruthy();
  });

  it("handles non-ApiError gracefully", () => {
    const msg = toUserMessage(new Error("plain error"));
    expect(msg.title).toBeTruthy();
    expect(msg.cta).toBe("retry");
  });

  it("handles string errors gracefully", () => {
    const msg = toUserMessage("something broke");
    expect(msg.title).toBeTruthy();
  });
});
