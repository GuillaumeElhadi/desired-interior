import { useState } from "react";

interface ResultViewProps {
  originalUrl: string;
  resultUrl: string;
  onBack: () => void;
  onRerender: () => void;
}

export function ResultView({ originalUrl, resultUrl, onBack, onRerender }: ResultViewProps) {
  const [position, setPosition] = useState(50);

  return (
    <div
      className="relative flex-1 overflow-hidden bg-gray-900"
      role="region"
      aria-label="Render result"
    >
      {/* Base layer: original room photo */}
      <img
        src={originalUrl}
        alt="Before"
        className="absolute inset-0 h-full w-full object-contain"
      />

      {/* Top layer: composed result, clipped by slider */}
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
        <img src={resultUrl} alt="After" className="h-full w-full object-contain" />
      </div>

      {/* Divider line */}
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-lg"
        style={{ left: `${position}%` }}
        aria-hidden="true"
      />

      {/* Edge labels */}
      <span className="absolute left-3 top-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
        Before
      </span>
      <span className="absolute right-3 top-3 rounded bg-black/50 px-2 py-0.5 text-xs text-white">
        After
      </span>

      {/* Transparent range input over the full width for dragging */}
      <input
        type="range"
        min={0}
        max={100}
        value={position}
        onChange={(e) => setPosition(Number(e.target.value))}
        className="absolute inset-x-0 bottom-16 w-full cursor-ew-resize opacity-0"
        aria-label="Before/after position"
      />

      {/* Controls */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-lg bg-black/75 px-4 py-2 backdrop-blur-sm">
        <button type="button" onClick={onBack} className="text-sm text-white hover:text-white/80">
          ← Edit
        </button>
        <button
          type="button"
          onClick={onRerender}
          className="rounded bg-brand-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          Re-render
        </button>
      </div>
    </div>
  );
}
