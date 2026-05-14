import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../components/SettingsPanel";
import * as api from "../lib/api";
import * as settings from "../lib/settings";

vi.mock("../lib/api", () => ({
  updateSettings: vi.fn(),
}));

vi.mock("../lib/settings", () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

const DEFAULT_PROPS = { onClose: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(settings.loadSettings).mockResolvedValue({ falKey: "" });
  vi.mocked(settings.saveSettings).mockResolvedValue(undefined);
  vi.mocked(api.updateSettings).mockResolvedValue(undefined);
});

describe("SettingsPanel", () => {
  it("renders the dialog with correct ARIA attributes", () => {
    render(<SettingsPanel {...DEFAULT_PROPS} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "settings-title");
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("loads and displays the stored fal key on mount", async () => {
    vi.mocked(settings.loadSettings).mockResolvedValue({ falKey: "fal_abc123" });
    render(<SettingsPanel {...DEFAULT_PROPS} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/fal\.ai api key/i)).toHaveValue("fal_abc123");
    });
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the X button is clicked", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close settings/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog); // click on the backdrop (target === currentTarget)
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves and syncs settings on Save click", async () => {
    render(<SettingsPanel {...DEFAULT_PROPS} />);
    const input = screen.getByLabelText(/fal\.ai api key/i);
    fireEvent.change(input, { target: { value: "fal_newkey" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      expect(settings.saveSettings).toHaveBeenCalledWith({ falKey: "fal_newkey" });
      expect(api.updateSettings).toHaveBeenCalledWith({ fal_key: "fal_newkey" });
    });
  });

  it("shows success message after successful save", async () => {
    render(<SettingsPanel {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  it("shows error message when save fails", async () => {
    vi.mocked(api.updateSettings).mockRejectedValue(new Error("network error"));
    render(<SettingsPanel {...DEFAULT_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("input is of type password", () => {
    render(<SettingsPanel {...DEFAULT_PROPS} />);
    expect(screen.getByLabelText(/fal\.ai api key/i)).toHaveAttribute("type", "password");
  });

  it("does not call onClose when inner content is clicked", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    // Click the dialog panel itself (not the backdrop)
    const panel = screen.getByRole("dialog").querySelector(".max-w-md");
    if (panel) fireEvent.click(panel as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Save button is disabled while saving", async () => {
    // Never-resolving save to keep the loading state
    vi.mocked(settings.saveSettings).mockReturnValue(new Promise(() => {}));
    render(<SettingsPanel {...DEFAULT_PROPS} />);
    const saveBtn = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
    });
  });
});
