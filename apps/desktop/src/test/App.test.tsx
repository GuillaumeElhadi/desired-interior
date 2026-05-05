import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import App from "../App";
import * as api from "../lib/api";

vi.mock("../lib/api", () => ({
  checkHealth: vi.fn(),
}));

const mockCheckHealth = vi.mocked(api.checkHealth);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("App", () => {
  it("renders the heading and shows connecting state initially", () => {
    mockCheckHealth.mockReturnValue(new Promise(() => {})); // never resolves
    render(<App />);
    expect(screen.getByRole("heading", { name: /interior vision/i })).toBeInTheDocument();
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
});
