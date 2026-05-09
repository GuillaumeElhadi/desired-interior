import Konva from "konva";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Stage, Transformer } from "react-konva";
import type { PreprocessResponse } from "../lib/api";
import {
  type ObjectRecord,
  type PlacementRecord,
  deletePlacement,
  loadObjects,
  loadPlacements,
  savePlacement,
  updatePlacement,
} from "../lib/db";

const SHA256_RE = /^[0-9a-f]{64}$/;
const SNAP_THRESHOLD = 0.2; // snap if within 20% of stage dims

interface PlacementCanvasProps {
  sceneId: string;
  imageUrl: string;
  masks: PreprocessResponse["masks"];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
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

export function PlacementCanvas({ sceneId, imageUrl, masks }: PlacementCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const stageRef = useRef<Konva.Stage>(null);

  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [roomImage, setRoomImage] = useState<HTMLImageElement | null>(null);
  const [placements, setPlacements] = useState<PlacementRecord[]>([]);
  const [objectsMap, setObjectsMap] = useState<
    Map<string, { record: ObjectRecord; image: HTMLImageElement }>
  >(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const objectId = e.dataTransfer.getData("application/x-interior-vision-object");
      if (!SHA256_RE.test(objectId)) return;

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
        } catch {
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
    },
    [objectsMap, sceneId, masks, stageSize]
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
    },
    []
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
    },
    []
  );

  // Compute room image render size (letterbox fit)
  const imgW = roomImage?.naturalWidth ?? 1;
  const imgH = roomImage?.naturalHeight ?? 1;
  const scale = Math.min(stageSize.width / imgW, stageSize.height / imgH);
  const roomRenderW = imgW * scale;
  const roomRenderH = imgH * scale;
  const roomOffsetX = (stageSize.width - roomRenderW) / 2;
  const roomOffsetY = (stageSize.height - roomRenderH) / 2;

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
          {roomImage && (
            <KonvaImage
              image={roomImage}
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
    </div>
  );
}
