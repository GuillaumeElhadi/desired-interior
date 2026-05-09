import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResultView } from "../components/ResultView";

const DEFAULT_PROPS = {
  originalUrl: "blob:original",
  resultUrl: "blob:result",
  onBack: vi.fn(),
  onRerender: vi.fn(),
};

describe("ResultView", () => {
  it("has an accessible region landmark", () => {
    render(<ResultView {...DEFAULT_PROPS} />);
    expect(screen.getByRole("region", { name: /render result/i })).toBeInTheDocument();
  });

  it("renders the Before image", () => {
    render(<ResultView {...DEFAULT_PROPS} />);
    expect(screen.getByAltText("Before")).toHaveAttribute("src", "blob:original");
  });

  it("renders the After image", () => {
    render(<ResultView {...DEFAULT_PROPS} />);
    expect(screen.getByAltText("After")).toHaveAttribute("src", "blob:result");
  });

  it("shows Before and After labels", () => {
    render(<ResultView {...DEFAULT_PROPS} />);
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
  });

  it("slider starts at 50", () => {
    render(<ResultView {...DEFAULT_PROPS} />);
    const slider = screen.getByRole("slider", { name: /before\/after position/i });
    expect(slider).toHaveValue("50");
  });

  it("slider onChange updates clip-path", () => {
    render(<ResultView {...DEFAULT_PROPS} />);
    const slider = screen.getByRole("slider", { name: /before\/after position/i });
    fireEvent.change(slider, { target: { value: "75" } });
    expect(slider).toHaveValue("75");
  });

  it("Edit button calls onBack", () => {
    const onBack = vi.fn();
    render(<ResultView {...DEFAULT_PROPS} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("Re-render button calls onRerender", () => {
    const onRerender = vi.fn();
    render(<ResultView {...DEFAULT_PROPS} onRerender={onRerender} />);
    fireEvent.click(screen.getByRole("button", { name: /re-render/i }));
    expect(onRerender).toHaveBeenCalledOnce();
  });
});
