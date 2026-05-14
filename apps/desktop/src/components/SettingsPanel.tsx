import { useEffect, useRef, useState } from "react";
import { updateSettings } from "../lib/api";
import { loadSettings, saveSettings } from "../lib/settings";
import * as telemetry from "../lib/telemetry";

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [falKey, setFalKey] = useState("");
  const [analyticsEnabled, setAnalyticsEnabled] = useState<boolean>(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSettings()
      .then(({ falKey: k, analyticsEnabled: a }) => {
        setFalKey(k);
        setAnalyticsEnabled(a ?? false);
      })
      .catch(console.error);
  }, []);

  // Focus the input after first paint (separate from data load).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const current = await loadSettings();
      await saveSettings({ ...current, falKey, analyticsEnabled });
      await updateSettings({ fal_key: falKey });
      telemetry.setEnabled(analyticsEnabled);
      setSaved(true);
    } catch (err: unknown) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap: redirect Tab/Shift+Tab back into the dialog.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, input, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div ref={dialogRef} className="w-full max-w-md rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 id="settings-title" className="text-base font-semibold text-gray-900">
            Settings
          </h2>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="rounded text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="space-y-6 px-6 py-5">
          {/* FAL_KEY */}
          <div>
            <label htmlFor="fal-key" className="mb-1.5 block text-sm font-medium text-gray-700">
              fal.ai API key
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                id="fal-key"
                type={showKey ? "text" : "password"}
                value={falKey}
                onChange={(e) => {
                  setFalKey(e.target.value);
                  setSaved(false);
                }}
                placeholder="fal_…"
                autoComplete="off"
                className="w-full rounded-lg border border-gray-300 py-2 pl-3 pr-10 text-sm font-mono focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/30"
                aria-describedby="fal-key-hint"
              />
              <button
                type="button"
                aria-label={showKey ? "Hide API key" : "Show API key"}
                onClick={() => setShowKey((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent"
              >
                {showKey ? (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                    />
                  </svg>
                ) : (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                    />
                  </svg>
                )}
              </button>
            </div>
            <p id="fal-key-hint" className="mt-1 text-xs text-gray-500">
              Required for scene rendering. Get a key at{" "}
              <span className="font-medium text-gray-700">fal.ai</span>.
            </p>
          </div>

          {/* Analytics */}
          <div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700">Anonymous analytics</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  Share render counts and durations. No images or personal data.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={analyticsEnabled}
                aria-label="Toggle anonymous analytics"
                onClick={() => setAnalyticsEnabled((v) => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2 ${
                  analyticsEnabled ? "bg-brand-accent" : "bg-gray-200"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                    analyticsEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Error / success feedback */}
          {saveError && (
            <p role="alert" className="text-xs text-red-600">
              {saveError}
            </p>
          )}
          {saved && (
            <p role="status" className="text-xs text-green-600">
              Settings saved — key is active.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
