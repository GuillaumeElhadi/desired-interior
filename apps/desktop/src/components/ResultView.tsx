import { useRef, useState } from "react";

interface ResultViewProps {
  originalUrl: string;
  resultUrl: string;
  onBack: () => void;
  onRerender: () => void;
}

export function ResultView({ originalUrl, resultUrl, onBack, onRerender }: ResultViewProps) {
  const [position, setPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const clamp = (v: number) => Math.max(0, Math.min(100, v));

  const updateFromPointer = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(clamp(((e.clientX - rect.left) / rect.width) * 100));
  };

  return (
    <div
      ref={containerRef}
      className="relative flex-1 select-none overflow-hidden bg-gray-900"
      role="region"
      aria-label="Render result"
      style={{ cursor: "ew-resize" }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        isDragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        updateFromPointer(e);
      }}
      onPointerMove={(e) => {
        if (isDragging.current) updateFromPointer(e);
      }}
      onPointerUp={() => {
        isDragging.current = false;
      }}
      onPointerCancel={() => {
        isDragging.current = false;
      }}
    >
      {/* Base layer: original room photo */}
      <img
        src={originalUrl}
        alt="Before"
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
      />

      {/* Top layer: composed result, clipped by slider position */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      >
        <img
          src={resultUrl}
          alt="After"
          draggable={false}
          className="h-full w-full object-contain"
        />
      </div>

      {/* Visible divider handle */}
      <div
        className="pointer-events-none absolute inset-y-0 flex -translate-x-1/2 items-center"
        style={{ left: `${position}%` }}
        aria-hidden="true"
      >
        <div className="absolute inset-y-0 w-0.5 bg-white shadow-lg" />
        <div className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white shadow-lg">
          <svg
            viewBox="0 0 20 20"
            className="h-4 w-4 text-gray-600"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M7 10H4m0 0 2-2M4 10l2 2M13 10h3m0 0-2-2m2 2-2 2" />
          </svg>
        </div>
      </div>

      {/* Hidden range input for keyboard accessibility */}
      <input
        type="range"
        min={0}
        max={100}
        value={position}
        onChange={(e) => setPosition(Number(e.target.value))}
        className="sr-only"
        aria-label="Before/after position"
      />

      {/* Edge labels */}
      <span className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/50 px-2 py-0.5 text-xs text-white">
        Before
      </span>
      <span className="pointer-events-none absolute right-3 top-3 rounded-lg bg-black/50 px-2 py-0.5 text-xs text-white">
        After
      </span>

      {/* Controls */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-lg bg-black/75 px-4 py-2 backdrop-blur-sm">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to edit"
          className="rounded text-sm text-white hover:text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/75"
        >
          ← Edit
        </button>
        <button
          type="button"
          onClick={onRerender}
          className="rounded-lg bg-brand-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
        >
          Re-render
        </button>
      </div>
    </div>
  );
}
