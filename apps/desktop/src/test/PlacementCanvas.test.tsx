import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlacementCanvas } from "../components/PlacementCanvas";
import * as api from "../lib/api";
import type { CleanSceneResponse, SegmentPointResponse } from "../lib/api";
import * as db from "../lib/db";

vi.mock("konva", () => ({ default: {} }));
// Fixed pointer position used by the Stage mock for erase-click tests.
// With room image 100×100, stage 800×600: scale=6, offsets=(100,0).
// imgX = round((200-100)/6) = 17, imgY = round((150-0)/6) = 25.
const MOCK_STAGE_POINTER = { x: 200, y: 150 };

vi.mock("react-konva", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Stage: forwardRef(
      ({ children, ...p }: React.ComponentProps<"div">, ref: React.Ref<unknown>) => {
        useImperativeHandle(ref, () => ({
          getPointerPosition: () => MOCK_STAGE_POINTER,
          container: () => null,
          findOne: () => null,
        }));
        return (
          <div data-testid="konva-stage" {...p}>
            {children}
          </div>
        );
      }
    ),
    Layer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Image: ({
      id,
      onClick,
      onContextMenu,
      opacity,
    }: {
      id?: string;
      image?: HTMLImageElement;
      onClick?: () => void;
      onContextMenu?: (e: { evt: MouseEvent }) => void;
      opacity?: number;
      [k: string]: unknown;
    }) => (
      <img
        data-testid={id != null ? `node-${id}` : "room-image"}
        data-opacity={opacity}
        id={id}
        onClick={onClick}
        onContextMenu={(e) => onContextMenu?.({ evt: e.nativeEvent })}
        alt=""
      />
    ),
    Rect: ({
      onClick,
      fill,
      "data-testid": testId,
      ...rest
    }: {
      onClick?: () => void;
      fill?: string;
      "data-testid"?: string;
      [k: string]: unknown;
    }) => (
      <div
        data-testid={testId ?? "mask-rect"}
        data-fill={fill}
        onClick={onClick}
        {...(rest as React.HTMLAttributes<HTMLDivElement>)}
      />
    ),
    Transformer: forwardRef(() => null),
  };
});

vi.mock("../lib/db", () => ({
  loadPlacements: vi.fn().mockResolvedValue([]),
  loadObjects: vi.fn().mockResolvedValue([]),
  savePlacement: vi.fn().mockResolvedValue(undefined),
  updatePlacement: vi.fn().mockResolvedValue(undefined),
  deletePlacement: vi.fn().mockResolvedValue(undefined),
  saveRender: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/api", () => ({
  compose: vi.fn(),
  composePreview: vi.fn(),
  cleanScene: vi.fn(),
  segmentPoint: vi.fn(),
}));

const SCENE_ID = "a".repeat(64);
const OBJECT_ID = "b".repeat(64);
const PLACEMENT_ID = "12345678-1234-1234-1234-123456789abc";

const MOCK_OBJECT: db.ObjectRecord = {
  id: OBJECT_ID,
  scene_id: SCENE_ID,
  name: "chair",
  masked_url: "https://cdn.fal.ai/masked.png",
  width: 100,
  height: 100,
  object_type: "floor",
  created_at: 1_700_000_000,
};

const MOCK_PLACEMENT: db.PlacementRecord = {
  id: PLACEMENT_ID,
  scene_id: SCENE_ID,
  object_id: OBJECT_ID,
  x: 100,
  y: 100,
  scale_x: 0.15,
  scale_y: 0.15,
  rotation: 0,
  depth_hint: 0.5,
  updated_at: 1_700_000_000,
};

const DEFAULT_PROPS = {
  sceneId: SCENE_ID,
  imageUrl: "blob:test-room-image",
  masks: [
    {
      url: "",
      label: "floor",
      score: 0.9,
      area: 240000,
      bbox: [0, 300, 800, 300],
      surface_type: "floor",
    },
  ],
};

function mockImageAutoLoad() {
  vi.spyOn(window, "Image").mockImplementation(function () {
    const img: Partial<HTMLImageElement> & {
      onload: (() => void) | null;
      onerror: (() => void) | null;
    } = {
      naturalWidth: 100,
      naturalHeight: 100,
      crossOrigin: "",
      onload: null,
      onerror: null,
    };
    let srcVal = "";
    Object.defineProperty(img, "src", {
      set(val: string) {
        srcVal = val;
        Promise.resolve().then(() => img.onload?.());
      },
      get() {
        return srcVal;
      },
    });
    return img as HTMLImageElement;
  } as unknown as typeof Image);
}

function stubCanvasContext() {
  const mockCtx = {
    fillStyle: "",
    fillRect: vi.fn(),
    globalCompositeOperation: "",
    drawImage: vi.fn(),
    // Return a fake ImageData so the binarization loop runs without throwing.
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
    putImageData: vi.fn(),
  };
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.getContext = vi
    .fn()
    .mockReturnValue(mockCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue("data:image/png;base64,dGVzdA==");
  return {
    mockCtx,
    restore() {
      HTMLCanvasElement.prototype.getContext = origGetContext;
      HTMLCanvasElement.prototype.toDataURL = origToDataURL;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockImageAutoLoad();
});

describe("PlacementCanvas — mounting", () => {
  it("renders the stage container", () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    expect(screen.getByTestId("konva-stage")).toBeInTheDocument();
  });

  it("has a region landmark with accessible label", () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    expect(screen.getByRole("region", { name: /placement canvas/i })).toBeInTheDocument();
  });

  it("loads placements and objects on mount", async () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await waitFor(() => {
      expect(db.loadPlacements).toHaveBeenCalledWith(SCENE_ID);
      expect(db.loadObjects).toHaveBeenCalledWith(SCENE_ID);
    });
  });

  it("renders placement nodes loaded from DB", async () => {
    vi.mocked(db.loadPlacements).mockResolvedValue([MOCK_PLACEMENT]);
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId(`node-${PLACEMENT_ID}`);
  });
});

describe("PlacementCanvas — drop handling", () => {
  it("rejects drops with an invalid object id", async () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    const region = screen.getByRole("region", { name: /placement canvas/i });
    fireEvent.drop(region, {
      dataTransfer: { getData: () => "not-a-sha256" },
    });
    await waitFor(() => {
      expect(db.savePlacement).not.toHaveBeenCalled();
    });
  });

  it("saves a new placement on a valid drop", async () => {
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    const region = screen.getByRole("region", { name: /placement canvas/i });
    fireEvent.drop(region, {
      dataTransfer: { getData: () => OBJECT_ID },
      clientX: 300,
      clientY: 300,
    });
    await waitFor(() => {
      expect(db.savePlacement).toHaveBeenCalledWith(
        expect.objectContaining({ object_id: OBJECT_ID, scene_id: SCENE_ID })
      );
    });
  });

  it("does not save when object is not found in DB", async () => {
    vi.mocked(db.loadObjects).mockResolvedValue([]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    const region = screen.getByRole("region", { name: /placement canvas/i });
    fireEvent.drop(region, {
      dataTransfer: { getData: () => OBJECT_ID },
    });
    await waitFor(() => {
      expect(db.savePlacement).not.toHaveBeenCalled();
    });
  });
});

describe("PlacementCanvas — keyboard shortcuts", () => {
  async function renderWithSelected() {
    vi.mocked(db.loadPlacements).mockResolvedValue([MOCK_PLACEMENT]);
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    const node = await screen.findByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.click(node);
    await screen.findByRole("slider", { name: /depth hint/i });
  }

  it("shows depth slider when a placement is selected", async () => {
    await renderWithSelected();
    expect(screen.getByRole("slider", { name: /depth hint/i })).toBeInTheDocument();
  });

  it("Escape deselects the placement", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("slider", { name: /depth hint/i })).not.toBeInTheDocument();
    });
  });

  it("Delete removes the selected placement", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => {
      expect(db.deletePlacement).toHaveBeenCalledWith(PLACEMENT_ID);
    });
  });

  it("Backspace removes the selected placement", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "Backspace" });
    await waitFor(() => {
      expect(db.deletePlacement).toHaveBeenCalledWith(PLACEMENT_ID);
    });
  });

  it("ArrowRight nudges placement +1px on X", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => {
      expect(db.updatePlacement).toHaveBeenCalledWith(
        expect.objectContaining({ x: MOCK_PLACEMENT.x + 1 })
      );
    });
  });

  it("Shift+ArrowDown nudges placement +10px on Y", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => {
      expect(db.updatePlacement).toHaveBeenCalledWith(
        expect.objectContaining({ y: MOCK_PLACEMENT.y + 10 })
      );
    });
  });

  it("R resets scale and rotation", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => {
      expect(db.updatePlacement).toHaveBeenCalledWith(
        expect.objectContaining({ scale_x: 1, scale_y: 1, rotation: 0 })
      );
    });
  });
});

describe("PlacementCanvas — render flow", () => {
  const COMPOSE_RESPONSE = {
    composition_id: "c".repeat(64),
    image: { url: "https://cdn.fal.ai/result.jpg", content_type: "image/jpeg" },
    composite_url: "https://cdn.fal.ai/result.jpg",
    mask_url: "data:image/png;base64,mask",
    depth_map_url: "https://cdn.fal.ai/depth.png",
  };

  async function renderWithPlacement() {
    vi.mocked(db.loadPlacements).mockResolvedValue([MOCK_PLACEMENT]);
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId(`node-${PLACEMENT_ID}`);
  }

  it("Render button is absent when no placements exist", () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    expect(screen.queryByRole("button", { name: /render/i })).not.toBeInTheDocument();
  });

  it("Render button is present when a placement exists", async () => {
    await renderWithPlacement();
    expect(screen.getByRole("button", { name: /render/i })).toBeInTheDocument();
  });

  it("clicking Render calls compose with correct scene/object ids", async () => {
    vi.mocked(api.compose).mockResolvedValue(COMPOSE_RESPONSE);
    await renderWithPlacement();
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await waitFor(() => {
      expect(api.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          scene_id: SCENE_ID,
          object_id: OBJECT_ID,
        }),
        expect.anything()
      );
    });
  });

  it("loading overlay is shown while rendering", async () => {
    vi.mocked(api.compose).mockReturnValue(new Promise(() => {})); // never resolves
    await renderWithPlacement();
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await waitFor(() => {
      expect(screen.getByText(/composing scene/i)).toBeInTheDocument();
    });
  });

  it("Cancel button aborts the request and hides the overlay", async () => {
    vi.mocked(api.compose).mockImplementation(
      (_req, signal) =>
        new Promise<typeof COMPOSE_RESPONSE>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    await renderWithPlacement();
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await screen.findByText(/composing scene/i);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByText(/composing scene/i)).not.toBeInTheDocument();
    });
  });

  it("error overlay is shown when compose rejects", async () => {
    vi.mocked(api.compose).mockRejectedValue(new Error("compose failed: 504 upstream timeout"));
    await renderWithPlacement();
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("Retry button re-calls compose", async () => {
    vi.mocked(api.compose)
      .mockRejectedValueOnce(new Error("compose failed: 502"))
      .mockResolvedValue(COMPOSE_RESPONSE);
    await renderWithPlacement();
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(api.compose).toHaveBeenCalledTimes(2);
    });
  });

  it("onRenderComplete is called with url and compositionId on success", async () => {
    vi.mocked(api.compose).mockResolvedValue(COMPOSE_RESPONSE);
    const onRenderComplete = vi.fn();
    vi.mocked(db.loadPlacements).mockResolvedValue([MOCK_PLACEMENT]);
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} onRenderComplete={onRenderComplete} />);
    await screen.findByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await waitFor(() => {
      expect(onRenderComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          url: COMPOSE_RESPONSE.image.url,
          compositionId: COMPOSE_RESPONSE.composition_id,
          sceneId: SCENE_ID,
          objects: expect.arrayContaining([expect.objectContaining({ object_id: OBJECT_ID })]),
        })
      );
    });
  });

  it("Render button calls compose (not composePreview) even when preview is active", async () => {
    vi.mocked(api.compose).mockResolvedValue(COMPOSE_RESPONSE);
    vi.mocked(api.composePreview).mockReturnValue(new Promise(() => {}));
    await renderWithPlacement();
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await waitFor(() => {
      expect(api.compose).toHaveBeenCalledTimes(1);
    });
  });

  it("shows API key error without calling compose when falKeyConfigured is false", async () => {
    vi.mocked(db.loadPlacements).mockResolvedValue([MOCK_PLACEMENT]);
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} falKeyConfigured={false} />);
    await screen.findByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.click(screen.getByRole("button", { name: /render/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(api.compose).not.toHaveBeenCalled();
  });
});

describe("PlacementCanvas — duplication", () => {
  async function renderWithSelected() {
    vi.mocked(db.loadPlacements).mockResolvedValue([MOCK_PLACEMENT]);
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    const node = await screen.findByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.click(node);
    // Depth slider appearing confirms selectedId is set and effects have flushed
    await screen.findByRole("slider", { name: /depth hint/i });
  }

  it("Cmd+D creates a new placement offset by 24px and persists it", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "d", metaKey: true });
    await waitFor(() => {
      expect(db.savePlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          scene_id: SCENE_ID,
          object_id: OBJECT_ID,
          x: MOCK_PLACEMENT.x + 24,
          y: MOCK_PLACEMENT.y + 24,
        })
      );
    });
  });

  it("Ctrl+D creates a new placement offset by 24px and persists it", async () => {
    await renderWithSelected();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    await waitFor(() => {
      expect(db.savePlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          scene_id: SCENE_ID,
          object_id: OBJECT_ID,
          x: MOCK_PLACEMENT.x + 24,
          y: MOCK_PLACEMENT.y + 24,
        })
      );
    });
  });

  it("floating toolbar Duplicate button creates a new placement", async () => {
    await renderWithSelected();
    const dupBtn = screen.getByRole("button", { name: /duplicate object/i });
    fireEvent.click(dupBtn);
    await waitFor(() => {
      expect(db.savePlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          scene_id: SCENE_ID,
          object_id: OBJECT_ID,
          x: MOCK_PLACEMENT.x + 24,
          y: MOCK_PLACEMENT.y + 24,
        })
      );
    });
  });

  it("right-click shows context menu with Duplicate menuitem", async () => {
    await renderWithSelected();
    const node = screen.getByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.contextMenu(node, { clientX: 200, clientY: 150 });
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });
    expect(screen.getByRole("menuitem", { name: /duplicate/i })).toBeInTheDocument();
  });

  it("right-click → Duplicate creates a new placement and closes the menu", async () => {
    await renderWithSelected();
    const node = screen.getByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.contextMenu(node, { clientX: 200, clientY: 150 });
    const menuItem = await screen.findByRole("menuitem", { name: /duplicate/i });
    fireEvent.click(menuItem);
    await waitFor(() => {
      expect(db.savePlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          scene_id: SCENE_ID,
          object_id: OBJECT_ID,
          x: MOCK_PLACEMENT.x + 24,
          y: MOCK_PLACEMENT.y + 24,
        })
      );
    });
    // Menu should close after duplication
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("Escape closes an open context menu", async () => {
    await renderWithSelected();
    const node = screen.getByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.contextMenu(node, { clientX: 200, clientY: 150 });
    await screen.findByRole("menu");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("context menu moves focus to the Duplicate menuitem on open", async () => {
    await renderWithSelected();
    const node = screen.getByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.contextMenu(node, { clientX: 200, clientY: 150 });
    await waitFor(() => {
      const menuItem = screen.getByRole("menuitem", { name: /duplicate/i });
      expect(document.activeElement).toBe(menuItem);
    });
  });

  it("Tab key closes the context menu", async () => {
    await renderWithSelected();
    const node = screen.getByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.contextMenu(node, { clientX: 200, clientY: 150 });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Tab" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("pointer-down outside the context menu closes it", async () => {
    await renderWithSelected();
    const node = screen.getByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.contextMenu(node, { clientX: 200, clientY: 150 });
    await screen.findByRole("menu");
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });
});

describe("PlacementCanvas — erase mode (point-based)", () => {
  // With room image 100×100, stage 800×600: scale=6, offsets=(100,0).
  // MOCK_STAGE_POINTER {x:200, y:150} → imgX=round((200-100)/6)=17, imgY=round(150/6)=25.
  const EXPECTED_IMG_X = 17;
  const EXPECTED_IMG_Y = 25;

  // Segment returned by the mock: bbox=[10,20,20,20] — contains (17,25) for deselect tests.
  const MOCK_SEGMENT: SegmentPointResponse = {
    mask_url: "data:image/png;base64,dGVzdA==",
    bbox: [10, 20, 20, 20],
    score: 0.9,
  };

  const CLEAN_RESPONSE: CleanSceneResponse = {
    cleaned_scene_id: "c".repeat(64),
    cleaned_url: "data:image/jpeg;base64,/9j/cleaned",
    content_type: "image/jpeg",
  };

  it("toolbar renders Place and Erase buttons by default", () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    expect(screen.getByRole("button", { name: /^place$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^erase$/i })).toBeInTheDocument();
  });

  it("Place button is pressed by default, Erase is not", () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    expect(screen.getByRole("button", { name: /^place$/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: /^erase$/i })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("clicking Erase shows cursor-crosshair and erase hint", async () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));
    await waitFor(() => {
      expect(screen.getByText(/click any object/i)).toBeInTheDocument();
    });
  });

  it("objects fade to 40% opacity in erase mode", async () => {
    vi.mocked(db.loadPlacements).mockResolvedValue([MOCK_PLACEMENT]);
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId(`node-${PLACEMENT_ID}`);
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));
    await waitFor(() => {
      expect(screen.getByTestId(`node-${PLACEMENT_ID}`)).toHaveAttribute("data-opacity", "0.4");
    });
  });

  it("clicking stage in erase mode calls segmentPoint with image coords", async () => {
    vi.mocked(api.segmentPoint).mockResolvedValue(MOCK_SEGMENT);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));
    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() => {
      expect(api.segmentPoint).toHaveBeenCalledWith(
        { scene_id: SCENE_ID, x: EXPECTED_IMG_X, y: EXPECTED_IMG_Y },
        expect.any(AbortSignal)
      );
    });
  });

  it("segment count increments in toolbar after successful segmentPoint", async () => {
    vi.mocked(api.segmentPoint).mockResolvedValue(MOCK_SEGMENT);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));
    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clean/i })).toHaveTextContent("1");
    });
  });

  it("second click within segment bbox deselects the segment", async () => {
    vi.mocked(api.segmentPoint).mockResolvedValue(MOCK_SEGMENT);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));
    // First click: adds segment
    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clean/i })).toHaveTextContent("1");
    });
    // Second click: same coords, within bbox → deselect
    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clean/i })).not.toHaveTextContent("1");
    });
    // segmentPoint should only have been called once (first click)
    expect(api.segmentPoint).toHaveBeenCalledTimes(1);
  });

  it("toolbar shows Selecting… while segmentPoint is in flight", async () => {
    vi.mocked(api.segmentPoint).mockReturnValue(new Promise(() => {})); // never resolves
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));
    fireEvent.click(screen.getByTestId("konva-stage"));
    // When isSegmenting=true the button text changes to "Selecting…" — query by current text.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /selecting/i })).toBeInTheDocument();
    });
  });

  it("segmentPoint error shows clean error overlay", async () => {
    vi.mocked(api.segmentPoint).mockRejectedValue(new Error("SAM failed: 502"));
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));
    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("Clean calls cleanScene and fires onSceneCleaned on success", async () => {
    const { restore } = stubCanvasContext();
    vi.mocked(api.segmentPoint).mockResolvedValue(MOCK_SEGMENT);
    vi.mocked(api.cleanScene).mockResolvedValue(CLEAN_RESPONSE);

    const onSceneCleaned = vi.fn();
    render(<PlacementCanvas {...DEFAULT_PROPS} onSceneCleaned={onSceneCleaned} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));

    // Add a segment
    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /clean/i })).toHaveTextContent("1")
    );

    // Click Clean
    fireEvent.click(screen.getByRole("button", { name: /clean/i }));

    await waitFor(() => {
      expect(api.cleanScene).toHaveBeenCalledWith(
        expect.objectContaining({ scene_id: SCENE_ID }),
        expect.any(AbortSignal)
      );
      expect(onSceneCleaned).toHaveBeenCalledWith(
        CLEAN_RESPONSE.cleaned_scene_id,
        CLEAN_RESPONSE.cleaned_url
      );
    });
    restore();
  });

  it("Clean error shows an error alert overlay", async () => {
    const { restore } = stubCanvasContext();
    vi.mocked(api.segmentPoint).mockResolvedValue(MOCK_SEGMENT);
    vi.mocked(api.cleanScene).mockRejectedValue(new Error("lama failed: 502"));

    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));

    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /clean/i })).toHaveTextContent("1")
    );
    fireEvent.click(screen.getByRole("button", { name: /clean/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    restore();
  });

  it("'Use cleaned scene' pill is visible when cleanedVariant prop is set", () => {
    render(
      <PlacementCanvas
        {...DEFAULT_PROPS}
        cleanedVariant={{ sceneId: "x".repeat(64), imageUrl: "blob:cleaned" }}
        isShowingCleanedScene={false}
      />
    );
    expect(screen.getByRole("button", { name: /use cleaned scene/i })).toBeInTheDocument();
  });

  it("'Restore original' pill is visible when isShowingCleanedScene is true", () => {
    render(
      <PlacementCanvas
        {...DEFAULT_PROPS}
        cleanedVariant={{ sceneId: "x".repeat(64), imageUrl: "blob:cleaned" }}
        isShowingCleanedScene={true}
        onRestoreOriginal={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /restore original/i })).toBeInTheDocument();
  });

  it("E key toggles between Place and Erase mode", async () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^erase$/i })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^place$/i })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
  });

  it("Escape in erase mode clears all segments", async () => {
    vi.mocked(api.segmentPoint).mockResolvedValue(MOCK_SEGMENT);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await screen.findByTestId("room-image");
    fireEvent.click(screen.getByRole("button", { name: /^erase$/i }));

    fireEvent.click(screen.getByTestId("konva-stage"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /clean/i })).toHaveTextContent("1")
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /clean/i })).not.toHaveTextContent("1");
    });
  });
});

describe("PlacementCanvas — preview", () => {
  const PREVIEW_RESPONSE = {
    preview_id: "d".repeat(64),
    image: { url: "https://cdn.fal.ai/preview.jpg", content_type: "image/jpeg" },
  };

  async function dropObject() {
    vi.mocked(db.loadObjects).mockResolvedValue([MOCK_OBJECT]);
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await waitFor(() => expect(db.loadObjects).toHaveBeenCalled());
    const region = screen.getByRole("region", { name: /placement canvas/i });
    await act(async () => {
      fireEvent.drop(region, {
        dataTransfer: { getData: () => OBJECT_ID },
        clientX: 300,
        clientY: 300,
      });
    });
    await waitFor(() => expect(db.savePlacement).toHaveBeenCalled());
  }

  it("no preview badge is shown when no placements exist", () => {
    render(<PlacementCanvas {...DEFAULT_PROPS} />);
    expect(screen.queryByText(/preview/i)).not.toBeInTheDocument();
  });

  it("badge shows 'Preview…' immediately after drop (debounce pending)", async () => {
    vi.mocked(api.composePreview).mockReturnValue(new Promise(() => {}));
    await dropObject();
    expect(screen.getByText(/preview…/i)).toBeInTheDocument();
  });

  it("composePreview is called after 800ms debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.composePreview).mockReturnValue(new Promise(() => {}));

    await dropObject();

    await act(async () => {
      vi.advanceTimersByTime(800);
    });

    expect(api.composePreview).toHaveBeenCalledTimes(1);
    expect(api.composePreview).toHaveBeenCalledWith(
      expect.objectContaining({ scene_id: SCENE_ID, object_id: OBJECT_ID }),
      expect.any(AbortSignal)
    );
    vi.useRealTimers();
  });

  it("badge shows 'Generating preview…' after debounce fires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.composePreview).mockReturnValue(new Promise(() => {}));

    await dropObject();

    await act(async () => {
      vi.advanceTimersByTime(800);
    });

    expect(screen.getByText(/generating preview…/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("badge shows 'Preview' when preview succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.composePreview).mockResolvedValue(PREVIEW_RESPONSE);

    await dropObject();

    await act(async () => {
      vi.advanceTimersByTime(800);
    });

    vi.useRealTimers();
    await waitFor(() => expect(screen.getAllByText(/^preview$/i).length).toBeGreaterThan(0));
  });

  it("badge shows 'Preview unavailable' when composePreview rejects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.composePreview).mockRejectedValue(new Error("preview failed: 502"));

    await dropObject();

    await act(async () => {
      vi.advanceTimersByTime(800);
    });

    vi.useRealTimers();
    // Both the visible badge and the sr-only live region will contain this text
    await waitFor(() =>
      expect(screen.getAllByText(/preview unavailable/i).length).toBeGreaterThan(0)
    );
  });

  it("preview badge is cleared when imageUrl prop changes", async () => {
    vi.mocked(api.composePreview).mockReturnValue(new Promise(() => {}));

    const { rerender } = render(<PlacementCanvas {...DEFAULT_PROPS} />);
    await waitFor(() => expect(db.loadObjects).toHaveBeenCalled());

    const region = screen.getByRole("region", { name: /placement canvas/i });
    await act(async () => {
      fireEvent.drop(region, {
        dataTransfer: { getData: () => OBJECT_ID },
        clientX: 300,
        clientY: 300,
      });
    });
    await waitFor(() => expect(screen.getByText(/preview…/i)).toBeInTheDocument());

    rerender(<PlacementCanvas {...DEFAULT_PROPS} imageUrl="blob:new-room-image" />);
    await waitFor(() => expect(screen.queryByText(/preview/i)).not.toBeInTheDocument());
  });
});
