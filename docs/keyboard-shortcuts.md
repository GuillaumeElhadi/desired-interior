# Keyboard Shortcuts

## Placement Canvas

These shortcuts are active when the Placement Canvas is visible (a room photo has been uploaded and processed).

### Object selection

| Key                 | Action                      |
| ------------------- | --------------------------- |
| `Escape`            | Deselect the current object |
| Click on object     | Select that object          |
| Click on background | Deselect                    |

### Moving a selected object

| Key                       | Movement                      |
| ------------------------- | ----------------------------- |
| `←` `→` `↑` `↓`           | Nudge 1 px in that direction  |
| `Shift` + `←` `→` `↑` `↓` | Nudge 10 px in that direction |

### Transforming a selected object

| Key | Action                                |
| --- | ------------------------------------- |
| `R` | Reset scale to 1×1 and rotation to 0° |

Drag the Konva transform handles to freely resize and rotate. Hold `Shift` while dragging a corner handle to resize proportionally.

### Duplicating a selected object

| Key                | Action                                                       |
| ------------------ | ------------------------------------------------------------ |
| `Cmd+D` / `Ctrl+D` | Duplicate the selected placement, offset by 24 px diagonally |

The duplicate becomes the new selection. Repeated duplications cascade the offset so placements never stack. The same action is available via the duplicate icon in the floating toolbar above the selection, or via **right-click → Duplicate**.

### Deleting a selected object

| Key         | Action                                        |
| ----------- | --------------------------------------------- |
| `Delete`    | Remove the selected placement from the canvas |
| `Backspace` | Remove the selected placement from the canvas |

Deletions are immediate and persisted to the local SQLite database.

### Depth hint

When an object is selected, a **Depth** slider appears at the bottom of the canvas. Drag it left (0) for foreground or right (1) for background. This value is passed to the composition pipeline when generating the final render.

## Erase mode

Erase mode lets you select SAM-segmented regions of the scene and remove them (e.g., pre-existing furniture, clutter) before placing new objects. Activate it via the **Place | Erase** toggle in the toolbar.

| Key      | Action                                   |
| -------- | ---------------------------------------- |
| `E`      | Toggle between Place and Erase mode      |
| `Escape` | Exit Erase mode and deselect all regions |

In Erase mode:

- Click any highlighted region to select it (glows red). Click again to deselect.
- The **Clean** button sends the union of selected regions to the backend for inpainting.
- The Clean button is disabled when no region is selected, or when the selection covers more than 20% of the image (backend safety rail).
- After a successful clean, a **"Use cleaned scene"** pill appears. Click it to swap the working scene to the cleaned variant.
- A **"Restore original"** affordance reverts back to the unmodified scene.
