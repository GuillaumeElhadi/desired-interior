import { useCallback, useRef, useState } from "react";
import type { PreprocessResponse } from "../lib/api";
import { preprocessScene } from "../lib/api";
import { toUserMessage } from "../lib/errors";

export interface SceneContext {
  sceneId: string;
  imageUrl: string;
  masks: PreprocessResponse["masks"];
}

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

type UploadState =
  | { phase: "idle" }
  | { phase: "preprocessing"; file: File; objectUrl: string }
  | { phase: "done"; file: File; objectUrl: string; sceneId: string }
  | {
      phase: "error";
      file: File | null;
      objectUrl: string | null;
      title: string;
      detail: string;
      canRetry: boolean;
    };

interface RoomUploadProps {
  disabled?: boolean;
  onSceneReady?: (ctx: SceneContext) => void;
}

function validateFile(file: File): string | null {
  if (!ACCEPTED_MIME.has(file.type)) {
    return `Unsupported file type "${file.type}". Please upload a JPEG, PNG, WEBP, or HEIC image.`;
  }
  if (file.size > MAX_BYTES) {
    return `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`;
  }
  return null;
}

export function RoomUpload({ disabled = false, onSceneReady }: RoomUploadProps) {
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      const error = validateFile(file);
      if (error) {
        setState({
          phase: "error",
          file,
          objectUrl: null,
          title: "Invalid file",
          detail: error,
          canRetry: false,
        });
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      setState({ phase: "preprocessing", file, objectUrl });
      try {
        const result = await preprocessScene(file);
        setState({ phase: "done", file, objectUrl, sceneId: result.scene_id });
        onSceneReady?.({ sceneId: result.scene_id, imageUrl: objectUrl, masks: result.masks });
      } catch (err) {
        const msg = toUserMessage(err);
        setState({
          phase: "error",
          file,
          objectUrl,
          title: msg.title,
          detail: msg.detail,
          canRetry: msg.cta === "retry",
        });
      }
    },
    [onSceneReady]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [disabled, handleFile]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setIsDragOver(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback(() => setIsDragOver(false), []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = "";
    },
    [handleFile]
  );

  const handleReset = useCallback(() => {
    setState((prev) => {
      if (prev.phase !== "idle" && prev.objectUrl) {
        URL.revokeObjectURL(prev.objectUrl);
      }
      return { phase: "idle" };
    });
  }, []);

  if (state.phase === "idle") {
    return (
      // Outer div carries the landmark role and drag events.
      // Inner <label> is the keyboard-activatable interactive zone — clicking it
      // opens the native file picker without any JS onClick handler.
      <div
        role="region"
        aria-label="Room photo upload"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={[
          "rounded-xl border-2 border-dashed transition-colors",
          isDragOver && !disabled
            ? "border-brand-accent bg-brand-accent/10"
            : "border-gray-300 bg-white",
          disabled ? "opacity-50" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <label
          htmlFor={disabled ? undefined : "room-photo-input"}
          className={[
            "flex flex-col items-center justify-center gap-4 p-16",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
          ].join(" ")}
        >
          <input
            id="room-photo-input"
            ref={inputRef}
            type="file"
            className="sr-only"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            onChange={handleInputChange}
            disabled={disabled}
            aria-label="Choose room photo"
          />
          <svg
            aria-hidden="true"
            className="h-12 w-12 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 20.25h18M13.5 10.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"
            />
          </svg>
          <div className="text-center">
            <p className="text-sm font-medium text-gray-700">
              {disabled ? "Waiting for API…" : "Drop a room photo here"}
            </p>
            {!disabled && (
              <p className="mt-1 text-xs text-gray-500">
                or{" "}
                <span className="text-brand-accent underline underline-offset-2">browse files</span>
                {" — "}JPEG, PNG, WEBP, HEIC · max 50 MB
              </p>
            )}
          </div>
        </label>
      </div>
    );
  }

  const { objectUrl } = state;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative overflow-hidden rounded-xl shadow-md">
        {objectUrl && (
          <img
            src={objectUrl}
            alt="Room preview"
            className="max-h-[480px] max-w-full object-contain"
            style={{ imageOrientation: "from-image" }}
          />
        )}
        {state.phase === "preprocessing" && (
          <div
            role="status"
            aria-label="Processing scene"
            className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          >
            <div className="motion-safe:animate-spin h-10 w-10 rounded-full border-4 border-white/30 border-t-white" />
          </div>
        )}
      </div>

      {state.phase === "done" && <p className="text-sm font-medium text-green-600">Scene ready</p>}

      {state.phase === "error" && (
        <div role="alert" className="flex max-w-sm flex-col items-center gap-2 text-center">
          <p className="text-sm font-medium text-red-700">{state.title}</p>
          <p className="text-sm text-red-600">{state.detail}</p>
          {state.canRetry && state.file && (
            <button
              type="button"
              onClick={() => void handleFile(state.file!)}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Disabled during preprocessing to prevent orphaned promise from writing
          stale state after the component has been reset. */}
      <button
        type="button"
        onClick={handleReset}
        disabled={state.phase === "preprocessing"}
        className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Upload a different photo
      </button>
    </div>
  );
}
