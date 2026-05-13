import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import App from "../App";
import * as api from "../lib/api";
import * as settingsLib from "../lib/settings";

vi.mock("../lib/api", () => ({
  checkHealth: vi.fn(),
  preprocessScene: vi.fn(),
  extractObject: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/settings", () => ({
  loadSettings: vi.fn().mockResolvedValue({ falKey: "" }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  loadObjects: vi.fn().mockResolvedValue([]),
  saveObject: vi.fn(),
  removeObject: vi.fn(),
  renameObject: vi.fn(),
  loadPlacements: vi.fn().mockResolvedValue([]),
  savePlacement: vi.fn(),
  updatePlacement: vi.fn(),
  deletePlacement: vi.fn(),
}));

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
    Image: forwardRef(() => <img alt="" />),
    Transformer: forwardRef(() => null),
  };
});

const mockCheckHealth = vi.mocked(api.checkHealth);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("App", () => {
  it("renders the heading", () => {
    mockCheckHealth.mockReturnValue(new Promise(() => {})); // never resolves
    render(<App />);
    expect(screen.getByRole("heading", { name: /interior vision/i })).toBeInTheDocument();
  });

  it("shows connecting state while waiting for sidecar", () => {
    mockCheckHealth.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByText(/connecting to api/i)).toBeInTheDocument();
  });

  it("shows healthy state when checkHealth resolves on first attempt", async () => {
    mockCheckHealth.mockResolvedValue({ status: "ok", version: "1.2.3" });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/api healthy · v1\.2\.3/i)).toBeInTheDocument();
    });
  });

  it("retries on transient failure and shows healthy on subsequent success", async () => {
    vi.useFakeTimers();
    mockCheckHealth
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue({ status: "ok", version: "0.0.0" });
    render(<App />);
    await vi.advanceTimersByTimeAsync(400); // past the 300 ms first retry delay
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByText(/api healthy/i)).toBeInTheDocument();
    });
  });

  it("shows error state after all retries are exhausted", async () => {
    vi.useFakeTimers();
    mockCheckHealth.mockRejectedValue(new Error("sidecar never started"));
    render(<App />);
    await vi.advanceTimersByTimeAsync(10000); // past all retry delays (~8.1 s total)
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByText(/api error/i)).toBeInTheDocument();
    });
  });

  it("renders the upload region once API is healthy", async () => {
    mockCheckHealth.mockResolvedValue({ status: "ok", version: "0.0.0" });
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: /room photo upload/i })).toBeInTheDocument();
    });
  });

  it("pushes stored fal key to sidecar after sidecar is ready", async () => {
    vi.mocked(settingsLib.loadSettings).mockResolvedValue({ falKey: "fal_test" });
    mockCheckHealth.mockResolvedValue({ status: "ok", version: "1.0.0" });
    render(<App />);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ fal_key: "fal_test" });
    });
  });

  it("shows gear settings button in header", () => {
    mockCheckHealth.mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(screen.getByRole("button", { name: /open settings/i })).toBeInTheDocument();
  });
});
