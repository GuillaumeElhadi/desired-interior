import Konva from "konva";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Stage, Transformer } from "react-konva";
import { type ComposeResponse, type PreprocessResponse, compose, composePreview } from "../lib/api";
import {
  type ObjectRecord,
  type PlacementRecord,
  deletePlacement,
  loadObjects,
  loadPlacements,
  saveRender,
  savePlacement,
  updatePlacement,
} from "../lib/db";

const SHA256_RE = /^[0-9a-f]{64}$/;
const SNAP_THRESHOLD = 0.2; // snap if within 20% of stage dims
const PREVIEW_DEBOUNCE_MS = 800;

type RenderPhase = "idle" | "rendering" | "error";
type PreviewPhase = "idle" | "pending" | "generating" | "ready" | "error";

interface RenderResult {
  url: string;
  compositionId: string;
}

interface PlacementCanvasProps {
  sceneId: string;
  imageUrl: string;
  masks: PreprocessResponse["masks"];
  onRenderComplete?: (result: RenderResult) => void;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  // Try with CORS first (needed for canvas export). If it fails — e.g. the CDN
  // doesn't allow the Tauri origin — retry without so the image still renders.
  return new Promise((resolve, reject) => {
    const withCors = new window.Image();
    withCors.crossOrigin = "anonymous";
    withCors.onload = () => resolve(withCors);
    withCors.onerror = () => {
      const noCors = new window.Image();
      noCors.onload = () => resolve(noCors);
      noCors.onerror = reject;
      noCors.src = url;
    };
    withCors.src = url;
  });
}

function snapToMask(
  x: number,
  y: number,
  masks: PreprocessResponse["masks"],
  stageWidth: number,
  stageHeight: number
): { x: number; y: number } {
  const threshold = Math.min(stageWidth, stageHeight) * SNAP_THRESHOLD;
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;

  for (const mask of masks) {
    if (mask.bbox.length < 4) continue;
    const [bx, by, bw, bh] = mask.bbox;
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < threshold && dist < bestDist) {
      bestDist = dist;
      best = { x: cx, y: cy };
    }
  }
  return best ?? { x, y };
}

export function PlacementCanvas({
  sceneId,
  imageUrl,
  masks,
  onRenderComplete,
}: PlacementCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewGenRef = useRef(0);

  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [roomImage, setRoomImage] = useState<HTMLImageElement | null>(null);
  const [placements, setPlacements] = useState<PlacementRecord[]>([]);
  const [objectsMap, setObjectsMap] = useState<
    Map<string, { record: ObjectRecord; image: HTMLImageElement }>
  >(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renderPhase, setRenderPhase] = useState<RenderPhase>("idle");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>("idle");
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(null);

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setStageSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load room image
  useEffect(() => {
    loadImage(imageUrl).then(setRoomImage).catch(console.error);
  }, [imageUrl]);

  // Abort in-flight preview requests when scene changes (timer + abort are side effects)
  useEffect(() => {
    if (previewDebounceRef.current !== null) {
      clearTimeout(previewDebounceRef.current);
      previewDebounceRef.current = null;
    }
    previewAbortRef.current?.abort();
  }, [imageUrl]);

  // Reset preview state when imageUrl changes — using render-time setState (React 18 pattern)
  // avoids triggering the react-hooks/set-state-in-effect rule.
  const [prevImageUrl, setPrevImageUrl] = useState(imageUrl);
  if (prevImageUrl !== imageUrl) {
    setPrevImageUrl(imageUrl);
    setPreviewPhase("idle");
    setPreviewImage(null);
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (previewDebounceRef.current !== null) {
        clearTimeout(previewDebounceRef.current);
      }
      previewAbortRef.current?.abort();
    };
  }, []);

  // Load placements + objects from DB
  useEffect(() => {
    Promise.all([loadPlacements(sceneId), loadObjects(sceneId)])
      .then(async ([ps, objs]) => {
        const map = new Map<string, { record: ObjectRecord; image: HTMLImageElement }>();
        await Promise.all(
          objs.map(async (obj) => {
            try {
              const img = await loadImage(obj.masked_url);
              map.set(obj.id, { record: obj, image: img });
            } catch {
              // skip unloadable thumbnails
            }
          })
        );
        setObjectsMap(map);
        setPlacements(ps);
      })
      .catch(console.error);
  }, [sceneId]);

  // Attach Transformer to selected node
  useEffect(() => {
    if (!trRef.current || !stageRef.current) return;
    if (selectedId) {
      const node = stageRef.current.findOne(`#${selectedId}`);
      if (node) {
        trRef.current.nodes([node]);
        trRef.current.getLayer()?.batchDraw();
      }
    } else {
      trRef.current.nodes([]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [selectedId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in any text-input context
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;

      if (!selectedId) {
        if (e.key === "Escape") setSelectedId(null);
        return;
      }

      const NUDGE = e.shiftKey ? 10 : 1;

      if (e.key === "Escape") {
        setSelectedId(null);
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void deletePlacement(selectedId).then(() => {
          setPlacements((prev) => prev.filter((p) => p.id !== selectedId));
          setSelectedId(null);
        });
        return;
      }

      if (e.key === "r" || e.key === "R") {
        // Require canvas to have focus so bare 'r' doesn't fire from sibling panels
        if (document.activeElement !== containerRef.current) return;
        setPlacements((prev) =>
          prev.map((p) => {
            if (p.id !== selectedId) return p;
            const updated = { ...p, scale_x: 1, scale_y: 1, rotation: 0, updated_at: Date.now() };
            void updatePlacement(updated);
            return updated;
          })
        );
        return;
      }

      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -NUDGE;
      if (e.key === "ArrowRight") dx = NUDGE;
      if (e.key === "ArrowUp") dy = -NUDGE;
      if (e.key === "ArrowDown") dy = NUDGE;
      if (dx !== 0 || dy !== 0) {
        e.preventDefault();
        setPlacements((prev) =>
          prev.map((p) => {
            if (p.id !== selectedId) return p;
            const updated = { ...p, x: p.x + dx, y: p.y + dy, updated_at: Date.now() };
            void updatePlacement(updated);
            return updated;
          })
        );
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId]);

  // Compute room image render size (letterbox fit) — hoisted for use in handleRender
  const imgW = roomImage?.naturalWidth ?? 1;
  const imgH = roomImage?.naturalHeight ?? 1;
  const scale = Math.min(stageSize.width / imgW, stageSize.height / imgH);
  const roomRenderW = imgW * scale;
  const roomRenderH = imgH * scale;
  const roomOffsetX = (stageSize.width - roomRenderW) / 2;
  const roomOffsetY = (stageSize.height - roomRenderH) / 2;

  const triggerPreview = useCallback(async () => {
    const target = placements.find((p) => p.id === selectedId) ?? placements[placements.length - 1];
    if (!target) return;
    const entry = objectsMap.get(target.object_id);
    if (!entry) return;

    const bbox = {
      x: (target.x - roomOffsetX) / scale,
      y: (target.y - roomOffsetY) / scale,
      width: (entry.image.naturalWidth * target.scale_x) / scale,
      height: (entry.image.naturalHeight * target.scale_y) / scale,
    };
    if (bbox.width <= 0 || bbox.height <= 0) return;

    const gen = ++previewGenRef.current;
    const ac = new AbortController();
    previewAbortRef.current = ac;
    setPreviewPhase("generating");

    try {
      const result = await composePreview(
        {
          scene_id: sceneId,
          object_id: target.object_id,
          placement: { bbox, depth_hint: target.depth_hint },
          style_hints: { prompt_suffix: "" },
        },
        ac.signal
      );
      const img = await loadImage(result.image.url);
      if (previewGenRef.current !== gen) return;
      setPreviewImage(img);
      setPreviewPhase("ready");
    } catch (err: unknown) {
      if (previewGenRef.current !== gen) return;
      if (err instanceof Error && err.name === "AbortError") {
        setPreviewPhase("idle");
      } else {
        setPreviewPhase("error");
      }
    }
  }, [placements, objectsMap, sceneId, scale, roomOffsetX, roomOffsetY, selectedId]);

  const schedulePreview = useCallback(() => {
    if (previewDebounceRef.current !== null) {
      clearTimeout(previewDebounceRef.current);
    }
    previewAbortRef.current?.abort();
    setPreviewPhase("pending");
    previewDebounceRef.current = setTimeout(() => {
      previewDebounceRef.current = null;
      void triggerPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }, [triggerPreview]);

  const handleRender = useCallback(async () => {
    const target = placements.find((p) => p.id === selectedId) ?? placements[placements.length - 1];
    if (!target) return;
    const entry = objectsMap.get(target.object_id);
    if (!entry) return;

    const bbox = {
      x: (target.x - roomOffsetX) / scale,
      y: (target.y - roomOffsetY) / scale,
      width: (entry.image.naturalWidth * target.scale_x) / scale,
      height: (entry.image.naturalHeight * target.scale_y) / scale,
    };

    if (bbox.width <= 0 || bbox.height <= 0) {
      setRenderPhase("error");
      setRenderError("Object has zero or negative dimensions — reset its scale and try again.");
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setRenderPhase("rendering");
    setRenderError(null);

    try {
      const result: ComposeResponse = await compose(
        {
          scene_id: sceneId,
          object_id: target.object_id,
          placement: { bbox, depth_hint: target.depth_hint },
          style_hints: { prompt_suffix: "" },
        },
        ac.signal
      );
      await saveRender({
        id: crypto.randomUUID(),
        scene_id: sceneId,
        composition_id: result.composition_id,
        result_url: result.image.url,
        created_at: Date.now(),
      });
      setRenderPhase("idle");
      onRenderComplete?.({ url: result.image.url, compositionId: result.composition_id });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setRenderPhase("idle");
      } else {
        // Show a safe generic message; the raw error may contain sidecar internals.
        setRenderPhase("error");
        setRenderError("Render failed. Please try again.");
      }
    }
  }, [
    placements,
    selectedId,
    objectsMap,
    sceneId,
    scale,
    roomOffsetX,
    roomOffsetY,
    onRenderComplete,
  ]);

  const handleCancelRender = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const objectId =
        e.dataTransfer.getData("application/x-interior-vision-object") ||
        e.dataTransfer.getData("text/plain");
      if (!SHA256_RE.test(objectId)) {
        console.warn("[PlacementCanvas] drop ignored — objectId not a SHA-256:", objectId);
        return;
      }

      // Load object image if not yet in map
      let entry = objectsMap.get(objectId);
      if (!entry) {
        const objs = await loadObjects(sceneId);
        const obj = objs.find((o) => o.id === objectId);
        if (!obj) return;
        try {
          const img = await loadImage(obj.masked_url);
          entry = { record: obj, image: img };
          setObjectsMap((prev) => new Map(prev).set(objectId, entry!));
        } catch (err) {
          console.error("[PlacementCanvas] failed to load object image:", obj.masked_url, err);
          return;
        }
      }

      // Compute drop position relative to stage
      const stageEl = stageRef.current?.container?.();
      const rect = stageEl?.getBoundingClientRect();
      const rawX = rect ? e.clientX - rect.left : stageSize.width / 2;
      const rawY = rect ? e.clientY - rect.top : stageSize.height / 2;

      const { x, y } = snapToMask(rawX, rawY, masks, stageSize.width, stageSize.height);

      const placement: PlacementRecord = {
        id: crypto.randomUUID(),
        scene_id: sceneId,
        object_id: objectId,
        x: x - (entry.image.naturalWidth * 0.15) / 2,
        y: y - (entry.image.naturalHeight * 0.15) / 2,
        scale_x: 0.15,
        scale_y: 0.15,
        rotation: 0,
        depth_hint: 0.5,
        updated_at: Date.now(),
      };

      await savePlacement(placement);
      setPlacements((prev) => [...prev, placement]);
      setSelectedId(placement.id);
      containerRef.current?.focus();
      schedulePreview();
    },
    [objectsMap, sceneId, masks, stageSize, schedulePreview]
  );

  const handleDragEnd = useCallback(
    (placementId: string) => (e: Konva.KonvaEventObject<DragEvent>) => {
      const node = e.target;
      setPlacements((prev) =>
        prev.map((p) => {
          if (p.id !== placementId) return p;
          const updated = { ...p, x: node.x(), y: node.y(), updated_at: Date.now() };
          void updatePlacement(updated);
          return updated;
        })
      );
      schedulePreview();
    },
    [schedulePreview]
  );

  const handleTransformEnd = useCallback(
    (placementId: string) => (e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      setPlacements((prev) =>
        prev.map((p) => {
          if (p.id !== placementId) return p;
          const updated = {
            ...p,
            x: node.x(),
            y: node.y(),
            scale_x: node.scaleX(),
            scale_y: node.scaleY(),
            rotation: node.rotation(),
            updated_at: Date.now(),
          };
          void updatePlacement(updated);
          return updated;
        })
      );
      schedulePreview();
    },
    [schedulePreview]
  );

  return (
    <div
      ref={containerRef}
      className="relative flex-1 overflow-hidden bg-gray-900 outline-none"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      aria-label="Placement canvas"
      role="region"
      tabIndex={0}
    >
      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        onClick={(e) => {
          const target = e.target as Konva.Node;
          if (typeof target.getStage === "function" && target === target.getStage()) {
            setSelectedId(null);
          }
        }}
      >
        <Layer>
          {(previewImage ?? roomImage) && (
            <KonvaImage
              image={(previewImage ?? roomImage)!}
              x={roomOffsetX}
              y={roomOffsetY}
              width={roomRenderW}
              height={roomRenderH}
              listening={false}
            />
          )}
          {placements.map((p) => {
            const entry = objectsMap.get(p.object_id);
            if (!entry) return null;
            return (
              <KonvaImage
                key={p.id}
                id={p.id}
                image={entry.image}
                x={p.x}
                y={p.y}
                scaleX={p.scale_x}
                scaleY={p.scale_y}
                rotation={p.rotation}
                draggable
                onClick={() => {
                  setSelectedId(p.id);
                  containerRef.current?.focus();
                }}
                onDragEnd={handleDragEnd(p.id)}
                onTransformEnd={handleTransformEnd(p.id)}
              />
            );
          })}
          <Transformer
            ref={trRef}
            rotateEnabled
            keepRatio={false}
            boundBoxFunc={(oldBox, newBox) =>
              newBox.width < 10 || newBox.height < 10 ? oldBox : newBox
            }
          />
        </Layer>
      </Stage>

      {/* Persistent live region — always in DOM so VoiceOver announces phase changes reliably */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {previewPhase === "pending" && placements.length > 0 && "Preview pending"}
        {previewPhase === "generating" && placements.length > 0 && "Generating preview"}
        {previewPhase === "ready" && placements.length > 0 && "Preview ready"}
        {previewPhase === "error" && placements.length > 0 && "Preview unavailable"}
      </div>

      {/* Preview status badge — top-left corner; hidden when no placements */}
      {previewPhase !== "idle" && placements.length > 0 && (
        <div className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
          {previewPhase === "pending" || previewPhase === "generating" ? (
            <>
              <span
                className="inline-block h-2 w-2 rounded-full border-2 border-white/30 border-t-white motion-safe:animate-spin"
                aria-hidden="true"
              />
              <span>{previewPhase === "pending" ? "Preview…" : "Generating preview…"}</span>
            </>
          ) : previewPhase === "ready" ? (
            <>
              <span className="h-2 w-2 rounded-full bg-green-400" aria-hidden="true" />
              <span>Preview</span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-red-400" aria-hidden="true" />
              <span>Preview unavailable</span>
            </>
          )}
        </div>
      )}

      {/* Depth hint slider for selected placement */}
      {selectedId &&
        (() => {
          const p = placements.find((pl) => pl.id === selectedId);
          if (!p) return null;
          return (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-lg bg-black/75 px-3 py-2 text-xs text-white backdrop-blur-sm">
              <span>Depth</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={p.depth_hint}
                onChange={(e) => {
                  const depth_hint = parseFloat(e.target.value);
                  setPlacements((prev) =>
                    prev.map((pl) => {
                      if (pl.id !== selectedId) return pl;
                      const updated = { ...pl, depth_hint, updated_at: Date.now() };
                      void updatePlacement(updated);
                      return updated;
                    })
                  );
                }}
                className="w-32 accent-brand-accent"
                aria-label="Depth hint"
              />
              <span className="w-8 text-right">{p.depth_hint.toFixed(2)}</span>
            </div>
          );
        })()}

      {/* Render button — bottom-right, hidden when an object is selected (avoids conflict
          with the Konva Transformer handles and the depth slider) */}
      {placements.length > 0 && renderPhase === "idle" && !selectedId && (
        <div className="absolute bottom-4 right-4 z-10">
          <button
            type="button"
            onClick={() => void handleRender()}
            className="rounded-lg bg-brand-accent px-4 py-2 text-sm font-semibold text-white shadow-lg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
          >
            Render
          </button>
        </div>
      )}

      {/* Loading overlay */}
      {renderPhase === "rendering" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="motion-safe:animate-spin h-10 w-10 rounded-full border-4 border-white/30 border-t-white" />
          <p className="mt-4 text-sm font-medium text-white">Composing scene…</p>
          <button
            type="button"
            onClick={handleCancelRender}
            className="mt-3 rounded px-3 py-1 text-xs text-white/70 underline underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Error overlay */}
      {renderPhase === "error" && renderError && (
        <div className="absolute bottom-4 right-4 z-10 flex max-w-xs flex-col items-end gap-2">
          <div role="alert" className="rounded-lg bg-red-900/80 px-3 py-2 text-xs text-red-100">
            {renderError}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRenderPhase("idle")}
              className="rounded px-2 py-1 text-xs text-white/60 underline underline-offset-2 hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={() => void handleRender()}
              className="rounded bg-brand-accent px-3 py-1 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
            >
              Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
