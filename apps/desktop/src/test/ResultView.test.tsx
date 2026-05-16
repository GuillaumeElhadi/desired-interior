import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResultView } from "../components/ResultView";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: (url: string) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BASE_PROPS = {
  originalUrl: "blob:original",
  resultUrl: "blob:result",
  onBack: vi.fn(),
  onRerender: vi.fn(),
};

// ---------------------------------------------------------------------------
// Existing proxy-mode tests (unchanged behaviour)
// ---------------------------------------------------------------------------

describe("ResultView — proxy mode (default)", () => {
  it("has an accessible region landmark", () => {
    render(<ResultView {...BASE_PROPS} />);
    expect(screen.getByRole("region", { name: /render result/i })).toBeInTheDocument();
  });

  it("renders the Before image with originalUrl", () => {
    render(<ResultView {...BASE_PROPS} />);
    expect(screen.getByAltText("Before")).toHaveAttribute("src", "blob:original");
  });

  it("renders the After image with resultUrl", () => {
    render(<ResultView {...BASE_PROPS} />);
    expect(screen.getByAltText("After")).toHaveAttribute("src", "blob:result");
  });

  it("shows Before and After labels", () => {
    render(<ResultView {...BASE_PROPS} />);
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("slider starts at 50", () => {
    render(<ResultView {...BASE_PROPS} />);
    const slider = screen.getByRole("slider", { name: /before.*after.*position/i });
    expect(slider).toHaveValue("50");
  });

  it("slider onChange updates position", () => {
    render(<ResultView {...BASE_PROPS} />);
    const slider = screen.getByRole("slider", { name: /before.*after.*position/i });
    fireEvent.change(slider, { target: { value: "75" } });
    expect(slider).toHaveValue("75");
  });

  it("Edit button calls onBack", () => {
    const onBack = vi.fn();
    render(<ResultView {...BASE_PROPS} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /back to edit/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("Re-render button calls onRerender", () => {
    const onRerender = vi.fn();
    render(<ResultView {...BASE_PROPS} onRerender={onRerender} />);
    fireEvent.click(screen.getByRole("button", { name: /re-render/i }));
    expect(onRerender).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Mode toggle rendering
// ---------------------------------------------------------------------------

describe("ResultView — render mode toggle", () => {
  it("renders Proxy and Harmonize buttons in a group", () => {
    render(<ResultView {...BASE_PROPS} />);
    const group = screen.getByRole("radiogroup", { name: /render mode/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^proxy$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^harmonize$/i })).toBeInTheDocument();
  });

  it("Proxy radio is checked by default", () => {
    render(<ResultView {...BASE_PROPS} />);
    expect(screen.getByRole("radio", { name: /^proxy$/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^harmonize$/i })).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("Harmonize button is disabled when onHarmonize is not provided", () => {
    render(<ResultView {...BASE_PROPS} />);
    expect(screen.getByRole("radio", { name: /^harmonize$/i })).toBeDisabled();
  });

  it("Harmonize button is enabled when onHarmonize is provided", () => {
    const onHarmonize = vi.fn(() => new Promise<string>(() => {}));
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);
    expect(screen.getByRole("radio", { name: /^harmonize$/i })).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Harmonising (loading) state
// ---------------------------------------------------------------------------

describe("ResultView — harmonising state", () => {
  it("shows loading overlay when Harmonize is clicked", async () => {
    const { promise } = deferred();
    const onHarmonize = vi.fn(() => promise);
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);

    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => {
      expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument();
    });
    expect(screen.getByText("Compositing…")).toBeInTheDocument();
  });

  it("calls onHarmonize with an AbortSignal", async () => {
    const { promise } = deferred();
    const onHarmonize = vi.fn((_signal: AbortSignal, _strength: number) => promise);
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);

    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => expect(onHarmonize).toHaveBeenCalledOnce());
    const signal = onHarmonize.mock.calls[0][0] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("disables the toggle while harmonising", async () => {
    const { promise } = deferred();
    render(<ResultView {...BASE_PROPS} onHarmonize={() => promise} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument()
    );

    expect(screen.getByRole("radio", { name: /^proxy$/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /^harmonize$/i })).toBeDisabled();
  });

  it("hides the before/after slider while harmonising", async () => {
    const { promise } = deferred();
    render(<ResultView {...BASE_PROPS} onHarmonize={() => promise} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument()
    );

    expect(
      screen.queryByRole("slider", { name: /before.*after.*position/i })
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Cancel behaviour
// ---------------------------------------------------------------------------

describe("ResultView — cancel", () => {
  it("Cancel button aborts the in-flight signal and returns to Proxy mode", async () => {
    const { promise } = deferred();
    const onHarmonize = vi.fn((_signal: AbortSignal, _strength: number) => promise);
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);

    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument()
    );

    const signal = onHarmonize.mock.calls[0][0] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(signal.aborted).toBe(true);

    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /harmonise progress/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("radio", { name: /^proxy$/i })).toHaveAttribute("aria-checked", "true");
  });

  it("resolving the cancelled promise does not update state", async () => {
    const { promise, resolve } = deferred();
    render(<ResultView {...BASE_PROPS} onHarmonize={() => promise} />);

    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    // Resolve the stale promise after cancel
    await act(async () => {
      resolve("data:image/jpeg;base64,stale");
    });

    // Should still be in proxy mode with no harmonised image
    expect(screen.getByRole("radio", { name: /^proxy$/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByAltText("After")).toHaveAttribute("src", "blob:result");
  });
});

// ---------------------------------------------------------------------------
// Success state
// ---------------------------------------------------------------------------

describe("ResultView — harmonise success", () => {
  it("shows harmonised image as After when successful", async () => {
    const onHarmonize = vi.fn(() => Promise.resolve("data:image/jpeg;base64,harmonized"));
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);

    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByAltText("After")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,harmonized"
      )
    );
  });

  it("shows proxy as Before when in harmonise compare mode", async () => {
    render(
      <ResultView
        {...BASE_PROPS}
        onHarmonize={() => Promise.resolve("data:image/jpeg;base64,harmonized")}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByAltText("Before")).toHaveAttribute("src", "blob:result")
    );
  });

  it("labels change to Proxy / Harmonised when comparing", async () => {
    render(
      <ResultView
        {...BASE_PROPS}
        onHarmonize={() => Promise.resolve("data:image/jpeg;base64,harmonized")}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => expect(screen.getByText("Proxy")).toBeInTheDocument());
    expect(screen.getByText("Harmonised")).toBeInTheDocument();
  });

  it("switching back to Proxy restores originalUrl as Before", async () => {
    render(
      <ResultView
        {...BASE_PROPS}
        onHarmonize={() => Promise.resolve("data:image/jpeg;base64,harmonized")}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));
    await waitFor(() => expect(screen.getByText("Harmonised")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: /^proxy$/i }));

    expect(screen.getByAltText("Before")).toHaveAttribute("src", "blob:original");
    expect(screen.getByAltText("After")).toHaveAttribute("src", "blob:result");
  });

  it("clicking Harmonize again when already successful does not re-call onHarmonize", async () => {
    const onHarmonize = vi.fn(() => Promise.resolve("data:image/jpeg;base64,harmonized"));
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));
    await waitFor(() => expect(screen.getByText("Harmonised")).toBeInTheDocument());

    // Switch to proxy, then back to harmonize
    fireEvent.click(screen.getByRole("radio", { name: /^proxy$/i }));
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    // Should still be exactly 1 call — result was cached
    expect(onHarmonize).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Failure state
// ---------------------------------------------------------------------------

describe("ResultView — harmonise failure", () => {
  it("shows failure overlay when onHarmonize rejects", async () => {
    const err = { errorCode: "fal_error" };
    render(<ResultView {...BASE_PROPS} onHarmonize={() => Promise.reject<string>(err)} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/render service error/i)).toBeInTheDocument();
  });

  it("shows Retry CTA for retryable errors", async () => {
    const err = { errorCode: "fal_error" };
    render(<ResultView {...BASE_PROPS} onHarmonize={() => Promise.reject<string>(err)} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument());
  });

  it("Retry button restarts the harmonise call", async () => {
    const onHarmonize = vi.fn(() => Promise.reject<string>({ errorCode: "fal_error" }));
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument());

    // Wire the second call to succeed
    onHarmonize.mockResolvedValueOnce("data:image/jpeg;base64,retry");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(screen.getByAltText("After")).toHaveAttribute("src", "data:image/jpeg;base64,retry")
    );
  });

  it("Back to Proxy button returns to proxy mode", async () => {
    render(
      <ResultView
        {...BASE_PROPS}
        onHarmonize={() => Promise.reject<string>({ errorCode: "fal_error" })}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /back to proxy/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /back to proxy/i }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^proxy$/i })).toHaveAttribute("aria-checked", "true");
  });

  it("shows correct message for offline error", async () => {
    render(
      <ResultView
        {...BASE_PROPS}
        onHarmonize={() => Promise.reject<string>({ errorCode: "offline" })}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/no internet connection/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Harmonize strength slider
// ---------------------------------------------------------------------------

describe("ResultView — harmonize_strength slider", () => {
  it("does not render the strength slider when onHarmonize is absent", () => {
    render(<ResultView {...BASE_PROPS} />);
    expect(screen.queryByLabelText(/^strength$/i)).not.toBeInTheDocument();
  });

  it("renders the strength slider when onHarmonize is provided", () => {
    render(<ResultView {...BASE_PROPS} onHarmonize={() => new Promise<string>(() => {})} />);
    expect(screen.getByLabelText(/^strength$/i)).toBeInTheDocument();
  });

  it("slider starts at midpoint 0.35 when no initialStrength is given", () => {
    render(<ResultView {...BASE_PROPS} onHarmonize={() => new Promise<string>(() => {})} />);
    const slider = screen.getByLabelText(/^strength$/i);
    expect(Number((slider as HTMLInputElement).value)).toBeCloseTo(0.35);
  });

  it("slider starts at initialStrength when provided", () => {
    render(
      <ResultView
        {...BASE_PROPS}
        onHarmonize={() => new Promise<string>(() => {})}
        initialStrength={0.42}
      />
    );
    const slider = screen.getByLabelText(/^strength$/i);
    expect(Number((slider as HTMLInputElement).value)).toBeCloseTo(0.42);
  });

  it("changing the slider calls onStrengthChange with the new value", () => {
    const onStrengthChange = vi.fn();
    render(
      <ResultView
        {...BASE_PROPS}
        onHarmonize={() => new Promise<string>(() => {})}
        onStrengthChange={onStrengthChange}
      />
    );
    const slider = screen.getByLabelText(/^strength$/i);
    fireEvent.change(slider, { target: { value: "0.45" } });
    expect(onStrengthChange).toHaveBeenCalledWith(0.45);
  });

  it("onHarmonize receives the current strength as second argument", async () => {
    const onHarmonize = vi.fn(() => new Promise<string>(() => {}));
    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} initialStrength={0.28} />);

    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() => expect(onHarmonize).toHaveBeenCalledOnce());
    const [, receivedStrength] = onHarmonize.mock.calls[0] as unknown as [AbortSignal, number];
    expect(receivedStrength).toBeCloseTo(0.28);
  });

  it("slider is disabled while harmonising", async () => {
    render(<ResultView {...BASE_PROPS} onHarmonize={() => new Promise<string>(() => {})} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument()
    );

    expect(screen.getByLabelText(/^strength$/i)).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Staged progress labels
// ---------------------------------------------------------------------------

describe("ResultView — staged progress", () => {
  it("shows a progress label while harmonising", async () => {
    render(<ResultView {...BASE_PROPS} onHarmonize={() => new Promise<string>(() => {})} />);
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument()
    );

    // The loading overlay shows one of the three staged labels
    const overlay = screen.getByRole("status", { name: /harmonise progress/i });
    const text = overlay.textContent ?? "";
    expect(
      text.includes("Compositing") || text.includes("Building mask") || text.includes("Harmonising")
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Race condition guard
// ---------------------------------------------------------------------------

describe("ResultView — race condition guard", () => {
  it("discards a stale response when a second harmonise starts before the first resolves", async () => {
    const d1 = deferred();
    const d2 = deferred();
    let callCount = 0;
    const onHarmonize = vi.fn(() => {
      callCount++;
      return callCount === 1 ? d1.promise : d2.promise;
    });

    render(<ResultView {...BASE_PROPS} onHarmonize={onHarmonize} />);

    // First call — goes to loading
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument()
    );

    // Cancel first call (increments generation, switches back to proxy)
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: /harmonise progress/i })).not.toBeInTheDocument()
    );

    // Second call
    fireEvent.click(screen.getByRole("radio", { name: /^harmonize$/i }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument()
    );

    // Resolve the stale first promise — should be ignored
    await act(async () => {
      d1.resolve("data:image/jpeg;base64,stale-url");
    });

    // State should still be loading (not success with stale url)
    expect(screen.getByRole("status", { name: /harmonise progress/i })).toBeInTheDocument();
    expect(screen.queryByAltText("After")).not.toBeInTheDocument();

    // Resolve the valid second promise
    await act(async () => {
      d2.resolve("data:image/jpeg;base64,final-url");
    });

    await waitFor(() =>
      expect(screen.getByAltText("After")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,final-url"
      )
    );
  });
});
