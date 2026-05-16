interface CanvasToolbarProps {
  mode: "place" | "erase";
  onModeChange: (mode: "place" | "erase") => void;
  selectedCount: number;
  exceedsSafetyRail: boolean;
  isCleaning: boolean;
  onClean: () => void;
}

const CLEAN_HINT_ID = "canvas-toolbar-clean-hint";

export function CanvasToolbar({
  mode,
  onModeChange,
  selectedCount,
  exceedsSafetyRail,
  isCleaning,
  onClean,
}: CanvasToolbarProps) {
  const cleanDisabled = selectedCount === 0 || exceedsSafetyRail || isCleaning;
  const cleanHint = exceedsSafetyRail
    ? "Selection covers >20% of the image — deselect some regions to continue"
    : selectedCount === 0
      ? "Select at least one region to clean"
      : undefined;

  return (
    <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg bg-black/75 p-1 backdrop-blur-sm">
      <button
        type="button"
        aria-pressed={mode === "place"}
        onClick={() => onModeChange("place")}
        title="Place mode (E to toggle)"
        className={`rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
          mode === "place" ? "bg-white text-gray-900" : "text-white/70 hover:text-white"
        }`}
      >
        Place
      </button>
      <button
        type="button"
        aria-pressed={mode === "erase"}
        onClick={() => onModeChange("erase")}
        title="Erase mode (E to toggle)"
        className={`rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
          mode === "erase" ? "bg-white text-gray-900" : "text-white/70 hover:text-white"
        }`}
      >
        Erase
      </button>

      {mode === "erase" && (
        <>
          <div className="mx-1 h-4 w-px bg-white/20" aria-hidden="true" />
          {cleanHint && (
            <span id={CLEAN_HINT_ID} className="sr-only">
              {cleanHint}
            </span>
          )}
          <button
            type="button"
            disabled={cleanDisabled}
            onClick={onClean}
            title={cleanHint ?? "Remove selected regions from the scene"}
            aria-describedby={cleanHint ? CLEAN_HINT_ID : undefined}
            className="flex items-center gap-1.5 rounded bg-brand-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-1 focus-visible:ring-offset-black/75"
          >
            {isCleaning ? (
              <>
                <span
                  className="inline-block h-3 w-3 rounded-full border-2 border-white/30 border-t-white motion-safe:animate-spin"
                  aria-hidden="true"
                />
                Cleaning…
              </>
            ) : (
              <>
                {selectedCount > 0 && (
                  <span className="rounded-full bg-white/25 px-1.5 tabular-nums">
                    {selectedCount}
                  </span>
                )}
                Clean
              </>
            )}
          </button>
        </>
      )}
    </div>
  );
}
