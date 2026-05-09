import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlacementCanvas } from "../components/PlacementCanvas";
import * as db from "../lib/db";

vi.mock("konva", () => ({ default: {} }));
vi.mock("react-konva", async () => {
  const { forwardRef } = await import("react");
  return {
    Stage: forwardRef(({ children, ...p }: React.ComponentProps<"div">) => (
      <div data-testid="konva-stage" {...p}>
        {children}
      </div>
    )),
    Layer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Image: ({
      id,
      onClick,
    }: {
      id?: string;
      image?: HTMLImageElement;
      onClick?: () => void;
      [k: string]: unknown;
    }) => (
      <img
        data-testid={id != null ? `node-${id}` : "room-image"}
        id={id}
        onClick={onClick}
        alt=""
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
  masks: [{ url: "", label: "floor", score: 0.9, area: 240000, bbox: [0, 300, 800, 300] }],
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
