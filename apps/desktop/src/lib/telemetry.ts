import posthog from "posthog-js";

let _enabled = false;
let _initialized = false;

export function init(enabled: boolean, distinctId: string): void {
  _enabled = enabled;
  _initialized = true;
  if (!enabled) return;
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) return;
  posthog.init(key, {
    api_host: "https://us.i.posthog.com",
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    persistence: "memory",
  });
  posthog.identify(distinctId);
}

export function setEnabled(enabled: boolean): void {
  _enabled = enabled;
  if (!_initialized) return;
  if (!enabled) {
    posthog.opt_out_capturing();
  } else {
    posthog.opt_in_capturing();
  }
}

export function track(name: string, props?: Record<string, unknown>): void {
  if (!_enabled || !_initialized) return;
  posthog.capture(name, props);
}

// Exported for test isolation only — do not call in production code.
export function _resetForTest(): void {
  _enabled = false;
  _initialized = false;
}

export function renderStarted(): void {
  track("render_started");
}

export function renderCompleted(durationMs: number): void {
  track("render_completed", { duration_ms: Math.round(durationMs) });
}

export function renderFailed(durationMs: number, errorClass: string): void {
  track("render_failed", { duration_ms: Math.round(durationMs), error_class: errorClass });
}

// These are wired in task 5.5 when the Harmonizer endpoint ships.
export function harmonizeStarted(): void {
  track("harmonize_started");
}

export function harmonizeCompleted(durationMs: number): void {
  track("harmonize_completed", { duration_ms: Math.round(durationMs) });
}

export function harmonizeFailed(durationMs: number, errorClass: string): void {
  track("harmonize_failed", { duration_ms: Math.round(durationMs), error_class: errorClass });
}
