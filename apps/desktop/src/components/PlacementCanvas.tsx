import Konva from "konva";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Stage, Transformer } from "react-konva";
import {
  type ComposeResponse,
  type ObjectPlacement,
  type PreprocessResponse,
  type SegmentPointResponse,
  cleanScene,
  compose,
  composePreview,
  segmentPoint,
} from "../lib/api";
import { toUserMessage } from "../lib/errors";
import * as telemetry from "../lib/telemetry";
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
import { duplicatePlacement } from "../lib/placements";
import { CanvasToolbar } from "./CanvasToolbar";

const SHA256_RE = /^[0-9a-f]{64}$/;
const PREVIEW_DEBOUNCE_MS = 800;
const ERASE_OBJECT_OPACITY = 0.4;

interface SegmentResult {
  id: string;
  maskUrl: string;
  displayImage: HTMLImageElement | null;
  bbox: number[];
  score: number;
}

async function colorizeSegmentMask(maskUrl: string): Promise<HTMLImageElement> {
  const maskImg = await loadImage(maskUrl);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = maskImg.naturalWidth;
    canvas.height = maskImg.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return maskImg;
    ctx.drawImage(maskImg, 0, 0);
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const isObj = d[i] > 128;
      d[i] = isObj ? 220 : 0;
      d[i + 1] = isObj ? 50 : 0;
      d[i + 2] = isObj ? 50 : 0;
      d[i + 3] = isObj ? 150 : 0;
    }
    ctx.putImageData(id, 0, 0);
    return loadImage(canvas.toDataURL("image/png"));
  } catch {
    return maskImg;
  }
}

type RenderPhase = "idle" | "rendering" | "error";
type CleanPhase = "idle" | "cleaning" | "error";

interface RenderErrorInfo {
  title: string;
  detail: string;
  cta: "retry" | "settings" | "reload" | "wait" | "none";
}
type PreviewPhase = "idle" | "pending" | "generating" | "ready" | "error";

interface RenderResult {
  url: string;
  compositionId: string;
  sceneId: string;
  objects: ObjectPlacement[];
}

interface PlacementCanvasProps {
  sceneId: string;
  imageUrl: string;
  masks: PreprocessResponse["masks"];
  onRenderComplete?: (result: RenderResult) => void;
  /** Object ID selected in the panel waiting to be placed on the canvas. */
  pendingObjectId?: string | null;
  /** Called after the pending object has been placed so the parent can clear it. */
  onPendingObjectPlaced?: () => void;
  /** Whether a fal.ai API key is configured — used to gate renders. */
  falKeyConfigured?: boolean;
  /** Called when the user clicks "Configure API key" in the render error. */
  onOpenSettings?: () => void;
  /** Called when the scene clean succeeds with the new cleaned variant ids. */
  onSceneCleaned?: (cleanedSceneId: string, cleanedUrl: string) => void;
  /** When set, shows the "Use cleaned scene" pill. */
  cleanedVariant?: { sceneId: string; imageUrl: string } | null;
  /** Called when the user accepts the cleaned variant. */
  onUseCleanedScene?: () => void;
  /** Called when the user reverts to the original scene. */
  onRestoreOriginal?: () => void;
  /** True when the canvas is currently showing the cleaned variant (not the original). */
  isShowingCleanedScene?: boolean;
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

/**
 * Find the best target on the appropriate surface for an object of a given type.
 *
 * Returns coordinates in IMAGE pixel space (not stage) — convert with
 * `imageToStage` before placing on the Konva stage.
 *
 * Multi-object spacing: if other objects of the same surface_type already exist,
 * the new one is offset to avoid stacking on the same point.
 */
function findSurfaceTarget(
  masks: PreprocessResponse["masks"],
  surface: "wall" | "floor",
  existingPlacements: PlacementRecord[],
  objectsMap: Map<string, { record: ObjectRecord; image: HTMLImageElement }>,
  objectNaturalSize: { width: number; height: number },
  imageToStage: (ix: number, iy: number) => { x: number; y: number },
  stageScale: number
): { x: number; y: number; scale: number } | null {
  const target = masks.find((m) => m.surface_type === surface);
  if (!target || target.bbox.length < 4) return null;

  const [bx, by, bw, bh] = target.bbox;
  // image-space → stage-space conversion for scale: a wall fraction in image
  // pixels maps to the same screen fraction once we apply stageScale.
  const targetWidthFraction = surface === "wall" ? 0.35 : 0.2;
  const targetImageWidth = bw * targetWidthFraction;
  const scale = (targetImageWidth * stageScale) / objectNaturalSize.width;

  // Default target: centre of the surface mask
  const cxImg = bx + bw / 2;
  const cyImg = by + bh / 2;

  // Multi-object offset: if same-surface objects already exist, place to the
  // right of the rightmost one (in stage space).
  const stageTarget = imageToStage(cxImg, cyImg);
  let cxStage = stageTarget.x;
  const cyStage = stageTarget.y;

  const sameSurface = existingPlacements.filter((p) => {
    const obj = objectsMap.get(p.object_id)?.record;
    return obj?.object_type === surface;
  });
  if (sameSurface.length > 0) {
    const rightmost = sameSurface.reduce((a, b) => (a.x > b.x ? a : b));
    const rightmostEntry = objectsMap.get(rightmost.object_id);
    if (rightmostEntry) {
      const offsetStage = rightmostEntry.image.naturalWidth * rightmost.scale_x * 1.2;
      const candidate = rightmost.x + offsetStage;
      const surfaceRightStage = imageToStage(bx + bw, cyImg).x;
      const newWidthStage = objectNaturalSize.width * scale;
      cxStage =
        candidate + newWidthStage / 2 > surfaceRightStage
          ? stageTarget.x
          : candidate + newWidthStage / 2;
    }
  }

  return {
    x: cxStage - (objectNaturalSize.width * scale) / 2,
    y: cyStage - (objectNaturalSize.height * scale) / 2,
    scale,
  };
}

export function PlacementCanvas({
  sceneId,
  imageUrl,
  masks,
  onRenderComplete,
  pendingObjectId,
  onPendingObjectPlaced,
  falKeyConfigured = true,
  onOpenSettings,
  onSceneCleaned,
  cleanedVariant,
  onUseCleanedScene,
  onRestoreOriginal,
  isShowingCleanedScene = false,
}: PlacementCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const abortRef = useRef<AbortController | null>(null);
  const contextMenuItemRef = useRef<HTMLButtonElement>(null);
  const handleDuplicateRef = useRef<(id: string) => Promise<void>>(async () => {});
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewGenRef = useRef(0);
  const errorDismissRef = useRef<HTMLButtonElement>(null);
  const cleanErrorDismissRef = useRef<HTMLButtonElement>(null);

  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [roomImage, setRoomImage] = useState<HTMLImageElement | null>(null);
  const [placements, setPlacements] = useState<PlacementRecord[]>([]);
  const [objectsMap, setObjectsMap] = useState<
    Map<string, { record: ObjectRecord; image: HTMLImageElement }>
  >(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    placementId: string;
  } | null>(null);
  const [renderPhase, setRenderPhase] = useState<RenderPhase>("idle");
  const [renderError, setRenderError] = useState<RenderErrorInfo | null>(null);
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>("idle");
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(null);

  // Erase mode
  const [canvasMode, setCanvasMode] = useState<"place" | "erase">("place");
  const [segments, setSegments] = useState<SegmentResult[]>([]);
  const [isSegmenting, setIsSegmenting] = useState(false);
  const [cleanPhase, setCleanPhase] = useState<CleanPhase>("idle");
  const [cleanError, setCleanError] = useState<RenderErrorInfo | null>(null);
  const cleanAbortRef = useRef<AbortController | null>(null);
  const segmentAbortRef = useRef<AbortController | null>(null);

  // Move keyboard focus to the dismiss button whenever a render error appears
  // so screen reader users and keyboard-only users are landed on the alert.
  useEffect(() => {
    if (renderPhase === "error") {
      errorDismissRef.current?.focus();
    }
  }, [renderPhase]);

  useEffect(() => {
    if (cleanPhase === "error") {
      cleanErrorDismissRef.current?.focus();
    }
  }, [cleanPhase]);

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

      // Toggle erase mode with E
      if ((e.key === "e" || e.key === "E") && !e.metaKey && !e.ctrlKey) {
        setCanvasMode((prev) => {
          if (prev === "erase") {
            segmentAbortRef.current?.abort();
            setSegments([]);
            setIsSegmenting(false);
            setCleanPhase("idle");
            setCleanError(null);
            return "place";
          }
          return "erase";
        });
        return;
      }

      // In erase mode, Escape deselects all segments
      if (canvasMode === "erase") {
        if (e.key === "Escape") {
          segmentAbortRef.current?.abort();
          setSegments([]);
          setIsSegmenting(false);
          setCleanPhase("idle");
          setCleanError(null);
        }
        return;
      }

      if (!selectedId) {
        if (e.key === "Escape") setSelectedId(null);
        return;
      }

      const NUDGE = e.shiftKey ? 10 : 1;

      if (e.key === "Escape") {
        setSelectedId(null);
        setContextMenu(null);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        void handleDuplicateRef.current(selectedId);
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
  }, [selectedId, canvasMode]);

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
          placement: { bbox, depth_hint: target.depth_hint, rotation: target.rotation },
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

  const handleModeChange = useCallback((mode: "place" | "erase") => {
    setCanvasMode(mode);
    if (mode === "place") {
      segmentAbortRef.current?.abort();
      setSegments([]);
      setIsSegmenting(false);
      setCleanPhase("idle");
      setCleanError(null);
    }
  }, []);

  const handleEraseClick = useCallback(
    async (stageX: number, stageY: number) => {
      if (!roomImage) return;

      const imgX = Math.round((stageX - roomOffsetX) / scale);
      const imgY = Math.round((stageY - roomOffsetY) / scale);

      // Bounds check
      if (imgX < 0 || imgY < 0 || imgX >= roomImage.naturalWidth || imgY >= roomImage.naturalHeight)
        return;

      // Toggle: click inside an existing segment's bbox → deselect
      const hitIdx = segments.findIndex((s) => {
        const [bx, by, bw, bh] = s.bbox;
        return imgX >= bx && imgX <= bx + bw && imgY >= by && imgY <= by + bh;
      });
      if (hitIdx !== -1) {
        setSegments((prev) => prev.filter((_, i) => i !== hitIdx));
        return;
      }

      // New point: run SAM segmentation
      segmentAbortRef.current?.abort();
      const ac = new AbortController();
      segmentAbortRef.current = ac;
      setIsSegmenting(true);

      try {
        const result: SegmentPointResponse = await segmentPoint(
          { scene_id: sceneId, x: imgX, y: imgY },
          ac.signal
        );
        const displayImage = await colorizeSegmentMask(result.mask_url);
        setSegments((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            maskUrl: result.mask_url,
            displayImage,
            bbox: result.bbox,
            score: result.score,
          },
        ]);
      } catch (err: unknown) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          setCleanPhase("error");
          setCleanError(toUserMessage(err));
        }
      } finally {
        setIsSegmenting(false);
      }
    },
    [roomImage, roomOffsetX, roomOffsetY, scale, segments, sceneId]
  );

  const handleClean = useCallback(async () => {
    if (!roomImage || segments.length === 0) return;

    const ac = new AbortController();
    cleanAbortRef.current = ac;
    setCleanPhase("cleaning");
    setCleanError(null);

    try {
      // Union all segment masks with "screen" compositing (lightest wins, giving OR of B/W masks).
      const { naturalWidth: w, naturalHeight: h } = roomImage;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas-not-supported");
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "screen";
      for (const seg of segments) {
        const maskImg = await loadImage(seg.maskUrl);
        ctx.drawImage(maskImg, 0, 0, w, h);
      }
      const maskDataUrl = canvas.toDataURL("image/png");

      const result = await cleanScene({ scene_id: sceneId, mask: maskDataUrl }, ac.signal);
      setCleanPhase("idle");
      setSegments([]);
      onSceneCleaned?.(result.cleaned_scene_id, result.cleaned_url);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setCleanPhase("idle");
      } else {
        const msg = toUserMessage(err);
        setCleanPhase("error");
        setCleanError(msg);
      }
    }
  }, [roomImage, segments, sceneId, onSceneCleaned]);

  const handleRender = useCallback(async () => {
    if (!falKeyConfigured) {
      setRenderPhase("error");
      setRenderError({
        title: "API key not configured",
        detail: "Add your fal.ai API key in Settings before rendering.",
        cta: "settings",
      });
      return;
    }
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
      setRenderError({
        title: "Invalid placement",
        detail: "Object has zero or negative dimensions — reset its scale and try again.",
        cta: "none",
      });
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setRenderPhase("rendering");
    setRenderError(null);

    const t0 = performance.now();
    telemetry.renderStarted();

    try {
      const result: ComposeResponse = await compose(
        {
          scene_id: sceneId,
          object_id: target.object_id,
          placement: { bbox, depth_hint: target.depth_hint, rotation: target.rotation },
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
      telemetry.renderCompleted(performance.now() - t0);
      setRenderPhase("idle");
      const objects: ObjectPlacement[] = placements.flatMap((p) => {
        const e = objectsMap.get(p.object_id);
        if (!e) return [];
        return [
          {
            object_id: p.object_id,
            placement: {
              bbox: {
                x: (p.x - roomOffsetX) / scale,
                y: (p.y - roomOffsetY) / scale,
                width: (e.image.naturalWidth * p.scale_x) / scale,
                height: (e.image.naturalHeight * p.scale_y) / scale,
              },
              depth_hint: p.depth_hint,
              rotation: p.rotation,
            },
          },
        ];
      });
      onRenderComplete?.({
        url: result.image.url,
        compositionId: result.composition_id,
        sceneId,
        objects,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        setRenderPhase("idle");
      } else {
        const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
        telemetry.renderFailed(performance.now() - t0, errorClass);
        const msg = toUserMessage(err);
        setRenderPhase("error");
        setRenderError(msg);
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
    falKeyConfigured,
  ]);

  const handleCancelRender = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleDuplicate = useCallback(
    async (placementId: string) => {
      const source = placements.find((p) => p.id === placementId);
      if (!source) return;
      const dup = duplicatePlacement(source);
      await savePlacement(dup);
      setPlacements((prev) => [...prev, dup]);
      setSelectedId(dup.id);
      setContextMenu(null);
    },
    [placements]
  );

  // Keep ref in sync so the keyboard handler always calls the latest version
  // without adding handleDuplicate to the keyboard effect's dep array.
  useEffect(() => {
    handleDuplicateRef.current = handleDuplicate;
  }, [handleDuplicate]);

  // Move focus into the context menu's first item when it opens (ARIA APG).
  useEffect(() => {
    if (contextMenu) contextMenuItemRef.current?.focus();
  }, [contextMenu]);

  // Dismiss context menu when the user clicks outside it.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: PointerEvent) => {
      const menu = contextMenuItemRef.current?.closest('[role="menu"]');
      if (menu && !menu.contains(e.target as Node)) setContextMenu(null);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [contextMenu]);

  const computeAutoPlacement = useCallback(
    (
      entry: { record: ObjectRecord; image: HTMLImageElement },
      fallbackStageX: number,
      fallbackStageY: number
    ): { x: number; y: number; scaleX: number; scaleY: number } => {
      const surface: "wall" | "floor" = entry.record.object_type === "wall" ? "wall" : "floor";
      const imageToStage = (ix: number, iy: number) => ({
        x: ix * scale + roomOffsetX,
        y: iy * scale + roomOffsetY,
      });
      const auto = findSurfaceTarget(
        masks,
        surface,
        placements,
        objectsMap,
        { width: entry.image.naturalWidth, height: entry.image.naturalHeight },
        imageToStage,
        scale
      );
      if (auto) {
        return { x: auto.x, y: auto.y, scaleX: auto.scale, scaleY: auto.scale };
      }
      // Fallback: place at click/drop position with default 15% scale
      return {
        x: fallbackStageX - (entry.image.naturalWidth * 0.15) / 2,
        y: fallbackStageY - (entry.image.naturalHeight * 0.15) / 2,
        scaleX: 0.15,
        scaleY: 0.15,
      };
    },
    [masks, placements, objectsMap, scale, roomOffsetX, roomOffsetY]
  );

  const handleClickPlace = useCallback(
    async (clickX: number, clickY: number) => {
      if (!pendingObjectId) return;

      let entry = objectsMap.get(pendingObjectId);
      if (!entry) {
        const objs = await loadObjects(sceneId);
        const obj = objs.find((o) => o.id === pendingObjectId);
        if (!obj) return;
        try {
          const img = await loadImage(obj.masked_url);
          entry = { record: obj, image: img };
          setObjectsMap((prev) => new Map(prev).set(pendingObjectId, entry!));
        } catch (err) {
          console.error("[PlacementCanvas] failed to load object image:", err);
          return;
        }
      }

      const auto = computeAutoPlacement(entry, clickX, clickY);

      const placement: PlacementRecord = {
        id: crypto.randomUUID(),
        scene_id: sceneId,
        object_id: pendingObjectId,
        x: auto.x,
        y: auto.y,
        scale_x: auto.scaleX,
        scale_y: auto.scaleY,
        rotation: 0,
        depth_hint: 0.5,
        updated_at: Date.now(),
      };

      await savePlacement(placement);
      setPlacements((prev) => [...prev, placement]);
      setSelectedId(placement.id);
      containerRef.current?.focus();
      onPendingObjectPlaced?.();
      schedulePreview();
    },
    [
      pendingObjectId,
      objectsMap,
      sceneId,
      computeAutoPlacement,
      onPendingObjectPlaced,
      schedulePreview,
    ]
  );

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

      const auto = computeAutoPlacement(entry, rawX, rawY);

      const placement: PlacementRecord = {
        id: crypto.randomUUID(),
        scene_id: sceneId,
        object_id: objectId,
        x: auto.x,
        y: auto.y,
        scale_x: auto.scaleX,
        scale_y: auto.scaleY,
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
    [objectsMap, sceneId, computeAutoPlacement, stageSize, schedulePreview]
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
      className={`relative flex-1 overflow-hidden bg-gray-900 outline-none ${canvasMode === "erase" ? (isSegmenting ? "cursor-wait" : "cursor-crosshair") : ""}`}
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
          const pos = stageRef.current?.getPointerPosition();
          if (canvasMode === "erase") {
            if (pos && !isSegmenting) void handleEraseClick(pos.x, pos.y);
            return;
          }
          const target = e.target as Konva.Node;
          const isBackground =
            typeof target.getStage === "function" && target === target.getStage();
          if (pendingObjectId && isBackground) {
            if (pos) void handleClickPlace(pos.x, pos.y);
          } else if (isBackground) {
            setSelectedId(null);
            setContextMenu(null);
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
                opacity={canvasMode === "erase" ? ERASE_OBJECT_OPACITY : 1}
                draggable={canvasMode === "place"}
                listening={canvasMode === "place"}
                onClick={() => {
                  if (canvasMode === "erase") return;
                  setSelectedId(p.id);
                  setContextMenu(null);
                  containerRef.current?.focus();
                }}
                onContextMenu={(e) => {
                  if (canvasMode === "erase") return;
                  e.evt.preventDefault();
                  setSelectedId(p.id);
                  containerRef.current?.focus();
                  const rect = containerRef.current?.getBoundingClientRect();
                  const x = e.evt.clientX - (rect?.left ?? 0);
                  const y = e.evt.clientY - (rect?.top ?? 0);
                  // Clamp so the menu stays inside the canvas (overflow-hidden clips it otherwise).
                  const MENU_W = 132;
                  const MENU_H = 44;
                  const safeX = Math.min(
                    x,
                    (containerRef.current?.clientWidth ?? 9999) - MENU_W - 4
                  );
                  const safeY = Math.min(
                    y,
                    (containerRef.current?.clientHeight ?? 9999) - MENU_H - 4
                  );
                  setContextMenu({ x: safeX, y: safeY, placementId: p.id });
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
            visible={canvasMode === "place"}
            boundBoxFunc={(oldBox, newBox) =>
              newBox.width < 10 || newBox.height < 10 ? oldBox : newBox
            }
          />
        </Layer>

        {/* Erase mode — colorized segment overlays */}
        {canvasMode === "erase" && segments.length > 0 && (
          <Layer listening={false}>
            {segments.map((seg) =>
              seg.displayImage ? (
                <KonvaImage
                  key={seg.id}
                  image={seg.displayImage}
                  x={roomOffsetX}
                  y={roomOffsetY}
                  width={roomRenderW}
                  height={roomRenderH}
                />
              ) : null
            )}
          </Layer>
        )}
      </Stage>

      {/* Erase mode — keyboard-accessible deselect buttons positioned over each segment bbox */}
      {canvasMode === "erase" && segments.length > 0 && (
        <div
          className="pointer-events-none absolute inset-0"
          aria-label="Selected segments"
          role="group"
        >
          {segments.map((seg, i) => {
            const [bx, by, bw, bh] = seg.bbox;
            return (
              <button
                key={seg.id}
                type="button"
                aria-label={`Selected region ${i + 1}, click to deselect`}
                onClick={() => setSegments((prev) => prev.filter((s) => s.id !== seg.id))}
                className="pointer-events-auto absolute opacity-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
                style={{
                  left: roomOffsetX + bx * scale,
                  top: roomOffsetY + by * scale,
                  width: bw * scale,
                  height: bh * scale,
                }}
              />
            );
          })}
        </div>
      )}

      {/* Canvas mode toolbar — always visible */}
      <CanvasToolbar
        mode={canvasMode}
        onModeChange={handleModeChange}
        segmentCount={segments.length}
        isSegmenting={isSegmenting}
        isCleaning={cleanPhase === "cleaning"}
        onClean={() => void handleClean()}
      />

      {/* Pending placement hint — only in place mode */}
      {pendingObjectId && canvasMode === "place" && (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
          <div className="rounded-full bg-brand-accent/90 px-4 py-1.5 text-xs font-medium text-white shadow backdrop-blur-sm">
            Click on the photo to place the object
          </div>
        </div>
      )}

      {/* Erase mode hint — hidden when cleaned variant pill occupies the same slot */}
      {canvasMode === "erase" && segments.length === 0 && !cleanedVariant && (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center">
          <div className="rounded-full bg-black/70 px-4 py-1.5 text-xs font-medium text-white shadow backdrop-blur-sm">
            Click any object to select it for removal
          </div>
        </div>
      )}

      {/* "Use cleaned scene" pill — appears after a successful clean */}
      {cleanedVariant && !isShowingCleanedScene && (
        <div className="absolute inset-x-0 top-14 z-10 flex justify-center">
          <div className="flex items-center gap-2 rounded-full bg-green-600/90 px-4 py-1.5 text-xs font-medium text-white shadow backdrop-blur-sm">
            <span>Scene cleaned</span>
            <button
              type="button"
              onClick={onUseCleanedScene}
              className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-green-700 hover:bg-green-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Use cleaned scene
            </button>
          </div>
        </div>
      )}

      {/* "Restore original" affordance — visible when showing the cleaned variant */}
      {isShowingCleanedScene && onRestoreOriginal && (
        <div className="absolute inset-x-0 top-14 z-10 flex justify-center">
          <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-1.5 text-xs font-medium text-white shadow backdrop-blur-sm">
            <span>Showing cleaned scene</span>
            <button
              type="button"
              onClick={onRestoreOriginal}
              className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Restore original
            </button>
          </div>
        </div>
      )}

      {/* Persistent live region — always in DOM so VoiceOver announces phase changes reliably */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {previewPhase === "pending" && placements.length > 0 && "Preview pending"}
        {previewPhase === "generating" && placements.length > 0 && "Generating preview"}
        {previewPhase === "ready" && placements.length > 0 && "Preview ready"}
        {previewPhase === "error" && placements.length > 0 && "Preview unavailable"}
        {isSegmenting && "Segmenting object, please wait"}
        {cleanPhase === "cleaning" && "Cleaning scene, please wait"}
      </div>

      {/* Preview status badge — top-left corner; hidden when no placements or in erase mode */}
      {previewPhase !== "idle" && placements.length > 0 && canvasMode === "place" && (
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

      {/* Depth hint slider for selected placement — place mode only */}
      {canvasMode === "place" &&
        selectedId &&
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

      {/* Floating selection toolbar — appears above the selected object, place mode only */}
      {canvasMode === "place" &&
        selectedId &&
        (() => {
          const p = placements.find((pl) => pl.id === selectedId);
          if (!p) return null;
          const entry = objectsMap.get(p.object_id);
          const naturalWidth = entry?.image.naturalWidth ?? 0;
          const centerX = p.x + (naturalWidth * p.scale_x) / 2;
          // 74 px clears Konva's rotation handle (≈32 px above bbox) + scale handles.
          // X center is unrotated; rotation drift is a known v1 limitation.
          const toolbarY = Math.max(8, p.y - 74);
          return (
            <div
              className="absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-black/75 px-1.5 py-1 backdrop-blur-sm"
              style={{ left: centerX, top: toolbarY }}
            >
              <button
                type="button"
                aria-label="Duplicate object"
                title="Duplicate (⌘D)"
                onClick={() => void handleDuplicate(selectedId)}
                className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2} />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
                  />
                </svg>
                Duplicate
              </button>
            </div>
          );
        })()}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="absolute z-30 min-w-32 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label="Object actions"
          onKeyDown={(e) => {
            if (e.key === "Tab" || e.key === "Escape") {
              e.stopPropagation();
              setContextMenu(null);
            }
          }}
        >
          <button
            ref={contextMenuItemRef}
            type="button"
            role="menuitem"
            onClick={() => void handleDuplicate(contextMenu.placementId)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-accent"
          >
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5 flex-shrink-0 text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2} />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"
              />
            </svg>
            Duplicate
            <span className="ml-auto pl-3 text-[11px] text-gray-400">⌘D</span>
          </button>
        </div>
      )}

      {/* Render button — bottom-right; hidden in erase mode or when an object is selected */}
      {canvasMode === "place" && placements.length > 0 && renderPhase === "idle" && !selectedId && (
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
        <div className="absolute bottom-4 right-4 z-10 flex max-w-sm flex-col items-start gap-2">
          <div role="alert" className="rounded-lg bg-red-900/80 px-3 py-2 text-xs text-red-100">
            <p className="font-semibold">{renderError.title}</p>
            <p className="mt-0.5 text-red-200">{renderError.detail}</p>
          </div>
          <div className="flex gap-2">
            <button
              ref={errorDismissRef}
              type="button"
              onClick={() => setRenderPhase("idle")}
              className="rounded-md border border-white/40 px-2 py-1 text-xs text-white/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Dismiss
            </button>
            {renderError.cta === "settings" && onOpenSettings ? (
              <button
                type="button"
                onClick={() => {
                  setRenderPhase("idle");
                  onOpenSettings();
                }}
                className="rounded-md bg-brand-accent px-3 py-1 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
              >
                Open Settings
              </button>
            ) : renderError.cta === "retry" ? (
              <button
                type="button"
                onClick={() => void handleRender()}
                className="rounded-md bg-brand-accent px-3 py-1 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
              >
                Retry
              </button>
            ) : renderError.cta === "reload" ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-md bg-brand-accent px-3 py-1 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
              >
                Reload
              </button>
            ) : renderError.cta === "wait" ? (
              <span className="text-xs text-white/70">Wait a moment, then retry.</span>
            ) : null}
          </div>
        </div>
      )}

      {/* Scene clean error overlay */}
      {cleanPhase === "error" && cleanError && (
        <div className="absolute bottom-4 right-4 z-10 flex max-w-sm flex-col items-start gap-2">
          <div role="alert" className="rounded-lg bg-red-900/80 px-3 py-2 text-xs text-red-100">
            <p className="font-semibold">{cleanError.title}</p>
            <p className="mt-0.5 text-red-200">{cleanError.detail}</p>
          </div>
          <div className="flex gap-2">
            <button
              ref={cleanErrorDismissRef}
              type="button"
              onClick={() => {
                setCleanPhase("idle");
                setCleanError(null);
              }}
              className="rounded-md border border-white/40 px-2 py-1 text-xs text-white/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Dismiss
            </button>
            {cleanError.cta === "retry" && (
              <button
                type="button"
                onClick={() => void handleClean()}
                className="rounded-md bg-red-500 px-3 py-1 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
              >
                Retry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
