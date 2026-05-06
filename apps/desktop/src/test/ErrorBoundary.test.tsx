import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/ErrorBoundary";

vi.mock("../lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  correlationId: "test-correlation-id",
}));

import { logger } from "../lib/logger";

const mockLoggerError = vi.mocked(logger.error);

// React logs error details to console.error during error boundary testing.
const originalConsoleError = console.error;
beforeEach(() => {
  vi.clearAllMocks();
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalConsoleError;
});

function Boom(): never {
  throw new Error("test explosion");
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <p>healthy content</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("healthy content")).toBeInTheDocument();
  });

  it("shows a fallback screen when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("heading", { name: /something went wrong/i })).toBeInTheDocument();
  });

  it("renders a Restart button in the fallback", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("button", { name: /restart/i })).toBeInTheDocument();
  });

  it("Restart button calls window.location.reload", async () => {
    const reloadSpy = vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload: vi.fn(),
    });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    await userEvent.click(screen.getByRole("button", { name: /restart/i }));
    expect(window.location.reload).toHaveBeenCalledOnce();
    reloadSpy.mockRestore();
  });

  it("shows error detail with role=status and data-testid", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    const detail = screen.getByTestId("error-detail");
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveAttribute("role", "status");
  });

  it("calls logger.error with the error message and component stack", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(mockLoggerError).toHaveBeenCalledOnce();
    expect(mockLoggerError).toHaveBeenCalledWith(
      "unhandled_react_error",
      expect.objectContaining({ message: "test explosion" })
    );
  });

  it("does not show the fallback when no error occurs", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>
    );
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });
});
