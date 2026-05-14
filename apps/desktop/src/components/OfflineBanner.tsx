export function OfflineBanner() {
  return (
    <div
      role="alert"
      aria-atomic="true"
      className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-800 ring-1 ring-amber-200"
    >
      <svg
        className="h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M18.364 5.636a9 9 0 010 12.728m-2.829-2.829a5 5 0 000-7.07M12 12h.01M8.464 8.464a5 5 0 000 7.072m-2.828 2.828a9 9 0 010-12.728"
        />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3l18 18" />
      </svg>
      <span>No internet connection — renders will fail until you&apos;re back online.</span>
    </div>
  );
}
