import { useCallback, useEffect, useRef, useState } from "react";
import { extractObject } from "../lib/api";
import { type ObjectRecord, loadObjects, removeObject, renameObject, saveObject } from "../lib/db";

interface ObjectPanelProps {
  sceneId: string | null;
  /** Called when the user starts dragging an object toward the canvas. */
  onObjectDragStart?: (objectId: string) => void;
}

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export function ObjectPanel({ sceneId, onObjectDragStart }: ObjectPanelProps) {
  const [objects, setObjects] = useState<ObjectRecord[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Load persisted objects whenever the active scene changes.
  useEffect(() => {
    if (!sceneId) return;
    loadObjects(sceneId).then(setObjects).catch(console.error);
  }, [sceneId]);

  // Derive the visible list: nothing is shown until a scene is active.
  const displayedObjects = sceneId ? objects : [];

  const handleFile = useCallback(
    async (file: File) => {
      if (!sceneId) return;
      if (!ACCEPTED_MIME.has(file.type)) {
        setExtractError(`Unsupported type "${file.type}". Use JPEG, PNG, WEBP, or HEIC.`);
        return;
      }
      setExtractError(null);
      setExtracting(true);
      try {
        const result = await extractObject(file);
        const record: ObjectRecord = {
          id: result.object_id,
          scene_id: sceneId,
          name: file.name.replace(/\.[^.]+$/, ""),
          masked_url: result.masked.url,
          width: result.masked.width,
          height: result.masked.height,
          created_at: Date.now(),
        };
        await saveObject(record);
        setObjects((prev) => [...prev, record]);
      } catch (err) {
        setExtractError(String(err));
      } finally {
        setExtracting(false);
      }
    },
    [sceneId]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = "";
    },
    [handleFile]
  );

  const handleRemove = useCallback(async (id: string) => {
    await removeObject(id);
    setObjects((prev) => prev.filter((o) => o.id !== id));
  }, []);

  const startRename = useCallback((obj: ObjectRecord) => {
    setRenamingId(obj.id);
    setRenameValue(obj.name);
  }, []);

  const commitRename = useCallback(
    async (id: string) => {
      const trimmed = renameValue.trim() || "Object";
      await renameObject(id, trimmed);
      setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, name: trimmed } : o)));
      setRenamingId(null);
    },
    [renameValue]
  );

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent, id: string) => {
      if (e.key === "Enter") void commitRename(id);
      if (e.key === "Escape") setRenamingId(null);
    },
    [commitRename]
  );

  return (
    <aside
      aria-label="Objects panel"
      className="flex w-72 flex-shrink-0 flex-col border-l border-gray-200 bg-white"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Objects</h2>
        <button
          type="button"
          aria-label="Add object"
          disabled={!sceneId || extracting}
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-brand-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {extracting ? "Extracting…" : "+ Add"}
        </button>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          onChange={handleInputChange}
          aria-label="Choose object photo"
        />
      </div>

      {/* Error banner */}
      {extractError && (
        <div role="alert" className="flex items-start gap-2 px-4 py-2 text-xs text-red-600">
          <span className="flex-1">{extractError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setExtractError(null)}
            className="flex-shrink-0 hover:text-red-800"
          >
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
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
      )}

      {/* Empty states — mutually exclusive with the list */}
      {!sceneId && (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-gray-500">
          Upload a room photo to start adding objects.
        </div>
      )}

      {sceneId && displayedObjects.length === 0 && !extracting ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-gray-500">
          No objects yet.
          <br />
          Click &ldquo;+ Add&rdquo; to add furniture.
        </div>
      ) : (
        /* Object list — only rendered when there are items */
        <ul className="flex-1 overflow-y-auto p-2 space-y-1">
          {displayedObjects.map((obj) => (
            <li
              key={obj.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-interior-vision-object", obj.id);
                e.dataTransfer.effectAllowed = "copy";
                onObjectDragStart?.(obj.id);
              }}
              className="flex cursor-grab items-center gap-3 rounded-lg p-2 hover:bg-gray-50 active:cursor-grabbing"
              aria-label={`Object: ${obj.name}`}
            >
              {/* Thumbnail */}
              <img
                src={obj.masked_url}
                alt={obj.name}
                loading="lazy"
                className="h-14 w-14 flex-shrink-0 rounded object-contain bg-gray-100"
              />

              {/* Name — editable on double-click */}
              <div className="min-w-0 flex-1">
                {renamingId === obj.id ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename(obj.id)}
                    onKeyDown={(e) => handleRenameKeyDown(e, obj.id)}
                    className="w-full rounded border border-brand-accent px-1 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-accent focus:ring-offset-1"
                    autoFocus
                    aria-label="Rename object"
                  />
                ) : (
                  <span
                    className="block truncate text-xs text-gray-700"
                    onDoubleClick={() => startRename(obj)}
                    title="Double-click to rename"
                  >
                    {obj.name}
                  </span>
                )}
              </div>

              {/* Remove — minimum 28×28 px target with SVG icon */}
              <button
                type="button"
                aria-label={`Remove ${obj.name}`}
                onClick={() => void handleRemove(obj.id)}
                className="flex min-h-7 min-w-7 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
