import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import App from "../App";

vi.mock("../lib/api", () => ({
  checkHealth: vi.fn().mockResolvedValue({ status: "ok", version: "0.0.0" }),
}));

describe("App", () => {
  it("renders the placeholder heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /interior vision/i })).toBeInTheDocument();
  });
});
