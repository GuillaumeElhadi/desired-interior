import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPosthog } = vi.hoisted(() => {
  const mockPosthog = {
    init: vi.fn(),
    identify: vi.fn(),
    capture: vi.fn(),
    opt_out_capturing: vi.fn(),
    opt_in_capturing: vi.fn(),
  };
  return { mockPosthog };
});

vi.mock("posthog-js", () => ({ default: mockPosthog }));

import {
  _resetForTest,
  harmonizeCompleted,
  harmonizeFailed,
  harmonizeStarted,
  init,
  renderCompleted,
  renderFailed,
  renderStarted,
  setEnabled,
} from "../lib/telemetry";

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTest();
});

afterEach(() => {
  _resetForTest();
});

describe("opt-out", () => {
  it("never calls posthog.capture when disabled", () => {
    init(false, "test-id");
    renderStarted();
    renderCompleted(100);
    renderFailed(200, "Error");
    harmonizeStarted();
    harmonizeCompleted(500);
    harmonizeFailed(600, "TimeoutError");
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it("does not call posthog.init when disabled", () => {
    init(false, "test-id");
    expect(mockPosthog.init).not.toHaveBeenCalled();
  });
});

describe("opt-in", () => {
  it("calls posthog.capture for render_started", () => {
    init(true, "test-id");
    renderStarted();
    expect(mockPosthog.capture).toHaveBeenCalledWith("render_started", undefined);
  });

  it("calls posthog.capture for render_completed with duration_ms", () => {
    init(true, "test-id");
    renderCompleted(1234.5);
    expect(mockPosthog.capture).toHaveBeenCalledWith("render_completed", { duration_ms: 1235 });
  });

  it("calls posthog.capture for render_failed with duration_ms and error_class", () => {
    init(true, "test-id");
    renderFailed(456.7, "NetworkError");
    expect(mockPosthog.capture).toHaveBeenCalledWith("render_failed", {
      duration_ms: 457,
      error_class: "NetworkError",
    });
  });

  it("calls posthog.capture for harmonize_started", () => {
    init(true, "test-id");
    harmonizeStarted();
    expect(mockPosthog.capture).toHaveBeenCalledWith("harmonize_started", undefined);
  });

  it("calls posthog.capture for harmonize_completed with duration_ms", () => {
    init(true, "test-id");
    harmonizeCompleted(9000);
    expect(mockPosthog.capture).toHaveBeenCalledWith("harmonize_completed", { duration_ms: 9000 });
  });

  it("calls posthog.capture for harmonize_failed with duration_ms and error_class", () => {
    init(true, "test-id");
    harmonizeFailed(1200, "AbortError");
    expect(mockPosthog.capture).toHaveBeenCalledWith("harmonize_failed", {
      duration_ms: 1200,
      error_class: "AbortError",
    });
  });
});

describe("no image content in event properties", () => {
  const forbidden = ["url", "image", "base64", "scene_id", "object_id"];

  it("render_completed properties contain only duration_ms", () => {
    init(true, "test-id");
    renderCompleted(100);
    const props = mockPosthog.capture.mock.calls[0][1] as Record<string, unknown>;
    for (const key of forbidden) {
      expect(props).not.toHaveProperty(key);
    }
  });

  it("render_failed properties contain only duration_ms and error_class", () => {
    init(true, "test-id");
    renderFailed(100, "TypeError");
    const props = mockPosthog.capture.mock.calls[0][1] as Record<string, unknown>;
    for (const key of forbidden) {
      expect(props).not.toHaveProperty(key);
    }
    expect(Object.keys(props)).toHaveLength(2);
  });
});

describe("setEnabled toggles after init", () => {
  it("stops capture calls when disabled after opt-in", () => {
    init(true, "test-id");
    renderStarted();
    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);

    setEnabled(false);
    renderStarted();
    renderCompleted(100);
    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
  });

  it("resumes capture calls when re-enabled", () => {
    init(true, "test-id");
    setEnabled(false);
    renderStarted();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    setEnabled(true);
    renderStarted();
    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
    expect(mockPosthog.opt_in_capturing).toHaveBeenCalledTimes(1);
  });
});
