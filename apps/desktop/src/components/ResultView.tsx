import { useCallback, useRef, useState } from "react";
import { toUserMessage, type UserMessage } from "../lib/errors";

type HarmonizePhase =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success"; url: string }
  | { type: "failure"; message: UserMessage };

type RenderMode = "proxy" | "harmonize";

interface ResultViewProps {
  originalUrl: string;
  resultUrl: string;
  onBack: () => void;
  onRerender: () => void;
  /** Called when the user triggers a harmonise pass. Receives an AbortSignal
   *  so the caller can cancel in-flight work. Resolves with the harmonised
   *  image URL (data URL or CDN URL). Optional: when absent the Harmonize
   *  toggle is rendered but disabled (wired in task 5.5). */
  onHarmonize?: (signal: AbortSignal) => Promise<string>;
}

export function ResultView({
  originalUrl,
  resultUrl,
  onBack,
  onRerender,
  onHarmonize,
}: ResultViewProps) {
  const [position, setPosition] = useState(50);
  const [mode, setMode] = useState<RenderMode>("proxy");
  const [harmonizePhase, setHarmonizePhase] = useState<HarmonizePhase>({ type: "idle" });
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Monotonically-increasing generation counter: guards against stale responses
  // from a previously-started harmonise call landing after it was cancelled.
  const genRef = useRef(0);

  const clamp = (v: number) => Math.max(0, Math.min(100, v));

  const updateFromPointer = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(clamp(((e.clientX - rect.left) / rect.width) * 100));
  };

  const startHarmonize = useCallback(() => {
    if (!onHarmonize) return;
    // Abort any in-flight request before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = ++genRef.current;

    setMode("harmonize");
    setHarmonizePhase({ type: "loading" });

    onHarmonize(controller.signal).then(
      (url) => {
        if (genRef.current !== gen) return; // stale response — discard
        setHarmonizePhase({ type: "success", url });
      },
      (err: unknown) => {
        if (genRef.current !== gen) return;
        if (controller.signal.aborted) return; // user-cancelled — stay in proxy
        setHarmonizePhase({ type: "failure", message: toUserMessage(err) });
      }
    );
  }, [onHarmonize]);

  const handleModeSelect = useCallback(
    (next: RenderMode) => {
      if (next === "harmonize") {
        if (!onHarmonize || harmonizePhase.type === "loading") return;
        if (harmonizePhase.type === "success") {
          setMode("harmonize");
          return;
        }
        startHarmonize();
      } else {
        if (harmonizePhase.type === "loading") {
          abortRef.current?.abort();
          genRef.current++; // invalidate any in-flight promise
          setHarmonizePhase({ type: "idle" });
        }
        setMode("proxy");
      }
    },
    [harmonizePhase.type, onHarmonize, startHarmonize]
  );

  const isLoading = harmonizePhase.type === "loading";
  const isFailure = mode === "harmonize" && harmonizePhase.type === "failure";
  const showHarmonizeCompare = mode === "harmonize" && harmonizePhase.type === "success";

  // What the before/after slider compares depends on the current state:
  // - Proxy mode or no harmonise yet: original room photo vs proxy composite
  // - Harmonise mode with result: proxy composite vs harmonised image
  const beforeUrl = showHarmonizeCompare ? resultUrl : originalUrl;
  const afterUrl = showHarmonizeCompare
    ? (harmonizePhase as { type: "success"; url: string }).url
    : resultUrl;
  const beforeLabel = showHarmonizeCompare ? "Proxy" : "Before";
  const afterLabel = showHarmonizeCompare ? "Harmonized" : "After";

  const overlayActive = isLoading || isFailure;

  return (
    <div
      ref={containerRef}
      className="relative flex-1 select-none overflow-hidden bg-gray-900"
      role="region"
      aria-label="Render result"
      style={{ cursor: overlayActive ? "default" : "ew-resize" }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        if (overlayActive) return;
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
      {/* Base layer: before image */}
      <img
        src={beforeUrl}
        alt="Before"
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
      />

      {/* Top layer: after image, clipped by slider. Hidden when an overlay is active. */}
      {!overlayActive && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          <img
            src={afterUrl}
            alt="After"
            draggable={false}
            className="h-full w-full object-contain"
          />
        </div>
      )}

      {/* Visible divider handle */}
      {!overlayActive && (
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
      )}

      {/* Hidden range input for keyboard accessibility */}
      {!overlayActive && (
        <input
          type="range"
          min={0}
          max={100}
          value={position}
          onChange={(e) => setPosition(Number(e.target.value))}
          className="sr-only"
          aria-label="Before/after position"
        />
      )}

      {/* Edge labels */}
      {!overlayActive && (
        <>
          <span className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/50 px-2 py-0.5 text-xs text-white">
            {beforeLabel}
          </span>
          <span className="pointer-events-none absolute right-3 top-3 rounded-lg bg-black/50 px-2 py-0.5 text-xs text-white">
            {afterLabel}
          </span>
        </>
      )}

      {/* Loading overlay */}
      {isLoading && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60"
          role="status"
          aria-live="polite"
          aria-label="Harmonising"
        >
          <svg
            className="h-8 w-8 animate-spin text-white"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <p className="text-sm text-white/90">Harmonising…</p>
          <button
            type="button"
            onClick={() => handleModeSelect("proxy")}
            className="rounded-lg bg-white/20 px-3 py-1.5 text-sm text-white hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Failure overlay */}
      {isFailure && harmonizePhase.type === "failure" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60"
          role="alert"
        >
          <p className="text-sm font-medium text-white">{harmonizePhase.message.title}</p>
          <p className="max-w-xs text-center text-xs text-white/70">
            {harmonizePhase.message.detail}
          </p>
          <div className="flex gap-2">
            {harmonizePhase.message.cta === "retry" && (
              <button
                type="button"
                onClick={startHarmonize}
                className="rounded-lg bg-brand-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent"
              >
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={() => handleModeSelect("proxy")}
              className="rounded-lg bg-white/20 px-3 py-1.5 text-sm text-white hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Back to Proxy
            </button>
          </div>
        </div>
      )}

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

        {/* Render mode toggle */}
        <div
          role="group"
          aria-label="Render mode"
          className="flex items-center rounded-md bg-white/10 p-0.5"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === "proxy"}
            onClick={() => handleModeSelect("proxy")}
            disabled={isLoading}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 ${
              mode === "proxy" ? "bg-white text-gray-900" : "text-white/80 hover:text-white"
            }`}
          >
            Proxy
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "harmonize"}
            onClick={() => handleModeSelect("harmonize")}
            disabled={isLoading || !onHarmonize}
            title={!onHarmonize ? "Harmonize will be available in a future update" : undefined}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50 ${
              mode === "harmonize" ? "bg-white text-gray-900" : "text-white/80 hover:text-white"
            }`}
          >
            Harmonize
          </button>
        </div>

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
