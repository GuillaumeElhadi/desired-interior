import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { RoomUpload } from "../components/RoomUpload";
import * as api from "../lib/api";

vi.mock("../lib/api", () => ({
  preprocessScene: vi.fn(),
  checkHealth: vi.fn(),
}));

const mockPreprocess = vi.mocked(api.preprocessScene);

// jsdom doesn't implement URL.createObjectURL / revokeObjectURL
URL.createObjectURL = vi.fn(() => "blob:mock-object-url");
URL.revokeObjectURL = vi.fn();

const MOCK_SCENE_ID = "a".repeat(64);
const MOCK_PREPROCESS_RESPONSE = {
  scene_id: MOCK_SCENE_ID,
  depth_map: { url: "https://cdn.fal.ai/depth.png", width: 512, height: 512 },
  masks: [],
  metadata: {
    dominant_surface: "floor",
    lighting_hint: "neutral",
    light_direction: "ambient",
    color_temperature: "neutral",
  },
};

function makeFile(name: string, type: string, sizeBytes = 1024): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(URL.createObjectURL).mockReturnValue("blob:mock-object-url");
});

// ---------------------------------------------------------------------------
// Idle state
// ---------------------------------------------------------------------------

describe("RoomUpload — idle state", () => {
  it("renders the upload region with correct aria label", () => {
    render(<RoomUpload />);
    expect(screen.getByRole("region", { name: /room photo upload/i })).toBeInTheDocument();
  });

  it("shows drop prompt text", () => {
    render(<RoomUpload />);
    expect(screen.getByText(/drop a room photo here/i)).toBeInTheDocument();
  });

  it("shows waiting text when disabled", () => {
    render(<RoomUpload disabled />);
    expect(screen.getByText(/waiting for api/i)).toBeInTheDocument();
  });

  it("has a hidden file input", () => {
    render(<RoomUpload />);
    expect(screen.getByLabelText(/choose room photo/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// File type validation
// ---------------------------------------------------------------------------

describe("RoomUpload — file type validation", () => {
  it.each([
    ["room.jpg", "image/jpeg"],
    ["room.jpeg", "image/jpeg"],
    ["room.png", "image/png"],
    ["room.webp", "image/webp"],
    ["room.heic", "image/heic"],
    ["room.heif", "image/heif"],
  ])("accepts %s (%s)", async (name, type) => {
    mockPreprocess.mockResolvedValue(MOCK_PREPROCESS_RESPONSE);
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    await userEvent.upload(input, makeFile(name, type));
    await waitFor(() => {
      expect(mockPreprocess).toHaveBeenCalledOnce();
    });
  });

  it("rejects unsupported file type and shows error", async () => {
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    // { applyAccept: false } bypasses userEvent's own accept filter so the file
    // reaches the component's validateFile, which is what we're testing here.
    await userEvent.upload(input, makeFile("document.pdf", "application/pdf"), {
      applyAccept: false,
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/unsupported file type/i);
    });
    expect(mockPreprocess).not.toHaveBeenCalled();
  });

  it("rejects files over 50 MB", async () => {
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    const bigFile = makeFile("room.jpg", "image/jpeg", 51 * 1024 * 1024);
    await userEvent.upload(input, bigFile);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/too large/i);
    });
    expect(mockPreprocess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

describe("RoomUpload — drag and drop", () => {
  it("highlights the drop zone on drag-over", () => {
    render(<RoomUpload />);
    const zone = screen.getByRole("region", { name: /room photo upload/i });
    fireEvent.dragOver(zone, { preventDefault: () => {} });
    expect(zone.className).toMatch(/border-blue/);
  });

  it("removes highlight on drag-leave", () => {
    render(<RoomUpload />);
    const zone = screen.getByRole("region", { name: /room photo upload/i });
    fireEvent.dragOver(zone, { preventDefault: () => {} });
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toMatch(/border-blue/);
  });

  it("processes a valid dropped file", async () => {
    mockPreprocess.mockResolvedValue(MOCK_PREPROCESS_RESPONSE);
    render(<RoomUpload />);
    const zone = screen.getByRole("region", { name: /room photo upload/i });
    const file = makeFile("room.jpg", "image/jpeg");
    fireEvent.drop(zone, {
      preventDefault: () => {},
      dataTransfer: { files: [file] },
    });
    await waitFor(() => {
      expect(mockPreprocess).toHaveBeenCalledWith(file);
    });
  });

  it("ignores drops when disabled", () => {
    render(<RoomUpload disabled />);
    const zone = screen.getByRole("region", { name: /room photo upload/i });
    const file = makeFile("room.jpg", "image/jpeg");
    fireEvent.drop(zone, {
      preventDefault: () => {},
      dataTransfer: { files: [file] },
    });
    expect(mockPreprocess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Preprocessing state
// ---------------------------------------------------------------------------

describe("RoomUpload — preprocessing state", () => {
  it("shows a spinner while preprocessing", async () => {
    let resolve: (v: typeof MOCK_PREPROCESS_RESPONSE) => void;
    mockPreprocess.mockReturnValue(
      new Promise<typeof MOCK_PREPROCESS_RESPONSE>((r) => {
        resolve = r;
      })
    );
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    await userEvent.upload(input, makeFile("room.jpg", "image/jpeg"));
    expect(screen.getByRole("status", { name: /processing scene/i })).toBeInTheDocument();
    resolve!(MOCK_PREPROCESS_RESPONSE);
  });

  it("shows the image preview while preprocessing", async () => {
    mockPreprocess.mockReturnValue(new Promise(() => {}));
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    await userEvent.upload(input, makeFile("room.jpg", "image/jpeg"));
    expect(screen.getByRole("img", { name: /room preview/i })).toHaveAttribute(
      "src",
      "blob:mock-object-url"
    );
  });
});

// ---------------------------------------------------------------------------
// Done state
// ---------------------------------------------------------------------------

describe("RoomUpload — done state", () => {
  it("shows a scene-ready message with truncated scene_id", async () => {
    mockPreprocess.mockResolvedValue(MOCK_PREPROCESS_RESPONSE);
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    await userEvent.upload(input, makeFile("room.jpg", "image/jpeg"));
    await waitFor(() => {
      expect(screen.getByText(/scene ready/i)).toBeInTheDocument();
    });
  });

  it("calls onSceneReady with the scene_id", async () => {
    mockPreprocess.mockResolvedValue(MOCK_PREPROCESS_RESPONSE);
    const onReady = vi.fn();
    render(<RoomUpload onSceneReady={onReady} />);
    const input = screen.getByLabelText(/choose room photo/i);
    await userEvent.upload(input, makeFile("room.jpg", "image/jpeg"));
    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith(MOCK_SCENE_ID);
    });
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe("RoomUpload — error state", () => {
  it("shows an error alert when preprocess fails", async () => {
    mockPreprocess.mockRejectedValue(new Error("preprocess failed: 502"));
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    await userEvent.upload(input, makeFile("room.jpg", "image/jpeg"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/preprocess failed/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("RoomUpload — reset", () => {
  it("returns to idle state and revokes object URL on reset", async () => {
    mockPreprocess.mockResolvedValue(MOCK_PREPROCESS_RESPONSE);
    render(<RoomUpload />);
    const input = screen.getByLabelText(/choose room photo/i);
    await userEvent.upload(input, makeFile("room.jpg", "image/jpeg"));
    await waitFor(() => screen.getByText(/scene ready/i));

    await userEvent.click(screen.getByRole("button", { name: /upload a different photo/i }));
    expect(screen.getByRole("region", { name: /room photo upload/i })).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-object-url");
  });
});

// ---------------------------------------------------------------------------
// Snapshot (visual regression baseline)
// ---------------------------------------------------------------------------

describe("RoomUpload — snapshot", () => {
  it("idle state matches snapshot", () => {
    const { container } = render(<RoomUpload />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
