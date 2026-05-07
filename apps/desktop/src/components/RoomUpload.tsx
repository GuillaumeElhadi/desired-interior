import { useCallback, useRef, useState } from "react";
import { preprocessScene } from "../lib/api";

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
  | { phase: "error"; file: File | null; objectUrl: string | null; message: string };

interface RoomUploadProps {
  disabled?: boolean;
  onSceneReady?: (sceneId: string) => void;
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
        setState({ phase: "error", file, objectUrl: null, message: error });
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      setState({ phase: "preprocessing", file, objectUrl });
      try {
        const result = await preprocessScene(file);
        setState({ phase: "done", file, objectUrl, sceneId: result.scene_id });
        onSceneReady?.(result.scene_id);
      } catch (err) {
        setState({ phase: "error", file, objectUrl, message: String(err) });
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
      <div
        role="region"
        aria-label="Room photo upload"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={[
          "flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-16 transition-colors",
          isDragOver && !disabled
            ? "border-blue-400 bg-blue-50"
            : "border-gray-300 bg-white hover:border-gray-400",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <input
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
              or <span className="text-blue-600 underline underline-offset-2">browse files</span>
              {" — "}JPEG, PNG, WEBP, HEIC · max 50 MB
            </p>
          )}
        </div>
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
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white border-t-transparent" />
          </div>
        )}
      </div>

      {state.phase === "done" && (
        <p className="text-sm font-medium text-green-600">
          Scene ready — ID: <span className="font-mono">{state.sceneId.slice(0, 12)}…</span>
        </p>
      )}

      {state.phase === "error" && (
        <p role="alert" className="max-w-sm text-center text-sm text-red-600">
          {state.message}
        </p>
      )}

      <button
        type="button"
        onClick={handleReset}
        className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-700"
      >
        Upload a different photo
      </button>
    </div>
  );
}
