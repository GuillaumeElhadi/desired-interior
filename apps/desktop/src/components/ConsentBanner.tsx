interface ConsentBannerProps {
  onAllow: () => void;
  onDecline: () => void;
}

export function ConsentBanner({ onAllow, onDecline }: ConsentBannerProps) {
  return (
    <div
      role="dialog"
      aria-labelledby="consent-title"
      aria-describedby="consent-desc"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white px-6 py-4 shadow-lg"
    >
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
        <div className="min-w-0">
          <p id="consent-title" className="text-sm font-medium text-gray-900">
            Help improve Interior Vision
          </p>
          <p id="consent-desc" className="mt-0.5 text-xs text-gray-500">
            Share anonymous usage data — render counts and durations only. No images, no personal
            info. You can change this at any time in Settings.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onDecline}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            No thanks
          </button>
          <button
            type="button"
            onClick={onAllow}
            className="rounded-lg bg-brand-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
