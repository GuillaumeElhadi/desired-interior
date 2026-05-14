import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectPanel } from "../components/ObjectPanel";
import * as api from "../lib/api";
import * as db from "../lib/db";
import type { ObjectRecord } from "../lib/db";

vi.mock("../lib/api", () => ({
  extractObject: vi.fn(),
  checkHealth: vi.fn(),
  preprocessScene: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  loadObjects: vi.fn(),
  saveObject: vi.fn(),
  removeObject: vi.fn(),
  renameObject: vi.fn(),
}));

const mockExtract = vi.mocked(api.extractObject);
const mockLoad = vi.mocked(db.loadObjects);
const mockSave = vi.mocked(db.saveObject);
const mockRemove = vi.mocked(db.removeObject);
const mockRename = vi.mocked(db.renameObject);

const SCENE_ID = "s".repeat(64);
const OBJECT_ID = "a".repeat(64);

const MOCK_OBJECT: ObjectRecord = {
  id: OBJECT_ID,
  scene_id: SCENE_ID,
  name: "chair",
  masked_url: "https://cdn.fal.ai/masked.png",
  width: 256,
  height: 256,
  object_type: "floor",
  created_at: 1_700_000_000,
};

const MOCK_EXTRACT_RESPONSE = {
  object_id: OBJECT_ID,
  masked: {
    url: "https://cdn.fal.ai/masked.png",
    width: 256,
    height: 256,
    content_type: "image/png",
    object_type: "floor",
  },
};

function makeFile(name: string, type = "image/jpeg"): File {
  return new File([new Uint8Array(64)], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoad.mockResolvedValue([]);
  mockSave.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// No sceneId
// ---------------------------------------------------------------------------

describe("ObjectPanel — no scene", () => {
  it("shows instruction text when sceneId is null", () => {
    render(<ObjectPanel sceneId={null} />);
    expect(screen.getByText(/upload a room photo/i)).toBeInTheDocument();
  });

  it("Add button is disabled when sceneId is null", () => {
    render(<ObjectPanel sceneId={null} />);
    expect(screen.getByRole("button", { name: /add object/i })).toBeDisabled();
  });

  it("does not call loadObjects when sceneId is null", () => {
    render(<ObjectPanel sceneId={null} />);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scene set — loading objects
// ---------------------------------------------------------------------------

describe("ObjectPanel — with scene", () => {
  it("calls loadObjects with sceneId on mount", async () => {
    mockLoad.mockResolvedValue([MOCK_OBJECT]);
    render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith(SCENE_ID));
  });

  it("shows empty state when no objects", async () => {
    render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => {
      expect(screen.getByText(/no objects yet/i)).toBeInTheDocument();
    });
  });

  it("renders loaded objects as list items", async () => {
    mockLoad.mockResolvedValue([MOCK_OBJECT]);
    render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => {
      expect(screen.getByRole("img", { name: "chair" })).toBeInTheDocument();
    });
    expect(screen.getByText("chair")).toBeInTheDocument();
  });

  it("reloads objects when sceneId changes", async () => {
    const secondScene = "b".repeat(64);
    const { rerender } = render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith(SCENE_ID));

    rerender(<ObjectPanel sceneId={secondScene} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith(secondScene));
  });
});

// ---------------------------------------------------------------------------
// Adding objects
// ---------------------------------------------------------------------------

describe("ObjectPanel — add object", () => {
  it("calls extractObject and saveObject on valid file, then shows thumbnail", async () => {
    mockExtract.mockResolvedValue(MOCK_EXTRACT_RESPONSE);
    render(<ObjectPanel sceneId={SCENE_ID} />);
    const input = screen.getByLabelText(/choose object photo/i);
    await userEvent.upload(input, makeFile("chair.jpg", "image/jpeg"));

    await waitFor(() => {
      expect(mockExtract).toHaveBeenCalledOnce();
      expect(mockSave).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole("img", { name: "chair" })).toBeInTheDocument();
  });

  it("shows 'Extracting…' while the API call is in progress", async () => {
    mockExtract.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ObjectPanel sceneId={SCENE_ID} />);
    const input = screen.getByLabelText(/choose object photo/i);
    await userEvent.upload(input, makeFile("chair.jpg", "image/jpeg"));
    expect(screen.getByRole("button", { name: /add object/i })).toHaveTextContent(/extracting/i);
  });

  it("shows error alert on extraction failure", async () => {
    mockExtract.mockRejectedValue(new Error("extract failed: 502"));
    render(<ObjectPanel sceneId={SCENE_ID} />);
    const input = screen.getByLabelText(/choose object photo/i);
    await userEvent.upload(input, makeFile("chair.jpg", "image/jpeg"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/extract failed/i);
    });
  });

  it("shows error alert for unsupported file type without calling API", async () => {
    render(<ObjectPanel sceneId={SCENE_ID} />);
    const input = screen.getByLabelText(/choose object photo/i);
    await userEvent.upload(input, makeFile("doc.pdf", "application/pdf"), {
      applyAccept: false,
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/unsupported type/i);
    });
    expect(mockExtract).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Removing objects
// ---------------------------------------------------------------------------

describe("ObjectPanel — remove object", () => {
  it("removes object from list and calls removeObject", async () => {
    mockLoad.mockResolvedValue([MOCK_OBJECT]);
    render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => screen.getByText("chair"));

    await userEvent.click(screen.getByRole("button", { name: /remove chair/i }));
    await waitFor(() => {
      expect(mockRemove).toHaveBeenCalledWith(OBJECT_ID);
    });
    expect(screen.queryByText("chair")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Renaming objects
// ---------------------------------------------------------------------------

describe("ObjectPanel — rename object", () => {
  it("shows rename input on double-click", async () => {
    mockLoad.mockResolvedValue([MOCK_OBJECT]);
    render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => screen.getByText("chair"));

    await userEvent.dblClick(screen.getByText("chair"));
    expect(screen.getByRole("textbox", { name: /rename object/i })).toBeInTheDocument();
  });

  it("commits rename on Enter and calls renameObject", async () => {
    mockLoad.mockResolvedValue([MOCK_OBJECT]);
    render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => screen.getByText("chair"));

    await userEvent.dblClick(screen.getByText("chair"));
    const input = screen.getByRole("textbox", { name: /rename object/i });
    await userEvent.clear(input);
    await userEvent.type(input, "sofa{Enter}");

    await waitFor(() => {
      expect(mockRename).toHaveBeenCalledWith(OBJECT_ID, "sofa");
    });
    expect(screen.getByText("sofa")).toBeInTheDocument();
  });

  it("cancels rename on Escape", async () => {
    mockLoad.mockResolvedValue([MOCK_OBJECT]);
    render(<ObjectPanel sceneId={SCENE_ID} />);
    await waitFor(() => screen.getByText("chair"));

    await userEvent.dblClick(screen.getByText("chair"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: /rename object/i })).not.toBeInTheDocument();
    expect(mockRename).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drag
// ---------------------------------------------------------------------------

describe("ObjectPanel — drag", () => {
  it("sets dataTransfer and calls onObjectDragStart on drag", async () => {
    mockLoad.mockResolvedValue([MOCK_OBJECT]);
    const onDragStart = vi.fn();
    render(<ObjectPanel sceneId={SCENE_ID} onObjectDragStart={onDragStart} />);
    await waitFor(() => screen.getByText("chair"));

    const item = screen.getByRole("listitem", { name: /object: chair/i });
    const dt = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(item, { dataTransfer: dt });

    expect(dt.setData).toHaveBeenCalledWith("application/x-interior-vision-object", OBJECT_ID);
    expect(onDragStart).toHaveBeenCalledWith(OBJECT_ID);
  });
});
