# Interior Vision — Roadmap

> **One unchecked checkbox = one task = one branch = one PR.**
>
> Tasks are designed to be sequential within a phase. Earlier phases gate later ones (e.g., don't write features before CI is in place). Within a phase, follow the order unless explicitly noted otherwise.
>
> **Acceptance criteria are non-negotiable.** A task is not done until every box is checked.

---

## Conventions reminder

- Branch naming: `feat|fix|chore|docs|refactor/<short-kebab>`
- Commits: Conventional Commits (`feat(scope): subject`)
- PR title: `<type>(<scope>): <subject> [task X.Y]`
- See `CLAUDE.md` for full rules.

---

## Vision technique — Workflow IA

The photoreal interior decoration workflow is articulated in 4 steps aligned with the Tauri → Python → fal.ai stack:

1. **Capture & Préparation** — Tauri UI uploads the room photo and the object reference photos. The sidecar pre-analyses the scene (`POST /scenes/preprocess` → Depth Anything V2 + SAM wall/floor segmentation) and detours each object on a transparent PNG via a **swappable background-removal driver layer** (`POST /objects/extract` → `BiRefNetDriver` by default, `BriaDriver` over `fal-ai/bria/remove-background` selected at runtime via the `BG_REMOVAL_BACKEND` env var — see task 4.7). Object type (wall vs floor) is also classified via Moondream so auto-placement targets the correct surface.
2. **Interaction UI Canvas** — React + Konva (`apps/desktop/src/components/PlacementCanvas.tsx`) hosts free placement, scale, rotation, **duplication**, and deletion of the detoured objects on top of the room photo. Placements are persisted per-project via SQLite on the Tauri side.
3. **Génération du Proxy** — `POST /compose` runs deterministic PIL/Pillow alpha-compositing inside the sidecar to produce a faithful preview (the user's exact pixels, at the chosen bbox + rotation) plus an explicit **binary B/W mask** marking where objects sit. The proxy + mask are the contract fed to the Harmonizer.
4. **Rendu Final — "Harmonizer" (High Fidelity)** — `POST /compose/harmonize` sends the proxy and mask to **fal.ai Flux Fill img2img + ControlNet Depth** on the room's depth map. This is the **primary path and the application's core value proposition**: defeat the "copy-paste" effect with photorealistic cast shadows, perspective alignment, light bounce, and edge integration. SDXL img2img is an **opt-in cost-optimisation fallback** behind `HARMONIZER_BACKEND=sdxl` — never the default. The mask plus a tuned `harmonize_strength` keep object identity intact while letting the model harmonise the surrounding pixels.

**Optional pre-step — Scene Cleanup.** Before placement, the user may erase pre-existing decoration from the room photo (an unwanted couch, a dated frame, clutter). `POST /scenes/clean` takes the room image plus a binary mask of the regions to remove and returns an inpainted "clean" variant via fal.ai (LaMa primary, Flux Fill erase mode as fallback). The cleaned image then becomes the working scene for the rest of the pipeline. Selection on the canvas reuses the SAM masks already produced by `/scenes/preprocess`, so a click-to-select interaction is enough to get started. See Phase 5 "Scene cleanup track" (tasks 5.8–5.10).

**IPC topology:**

```
React UI (Konva canvas)
     │
     │  fetch (localhost:port)
     ▼
Tauri (Rust)  ──spawn/manage──▶  FastAPI sidecar (Python 3.12)
                                       │
                                       │  fal-client (auth via FAL_KEY)
                                       ▼
                                    fal.ai
                          (BiRefNet, Depth Anything V2, SAM,
                           Moondream, Flux Fill, SDXL, ControlNet)
```

Cloud-only ML is intentional in V1 — see ADR-0003. All fal.ai access is funnelled through `apps/api/app/cloud/fal_client.py`; no fal SDK import is allowed elsewhere (`architecture-keeper` agent enforces). Related ADRs: [0003 sidecar packaging](docs/adr/0003-sidecar-packaging.md), [0006 canvas library](docs/adr/0006-canvas-library.md), [0007 PIL proxy over Flux Fill](docs/adr/0007-pil-compositing-over-flux-fill.md). A new ADR-0008 will document the Harmonizer trade-offs (see task 5.7).

---

## Phase 0 — Foundation

> Goal: a repository where every PR is automatically validated, every commit is well-formed, and releases happen by themselves. **No feature code in this phase.**

### 0.1 Initialize repository

- [x] Branch: `chore/init-repo`
- **Steps:**
  - `gh repo create interior-vision --private --source=. --remote=origin`
  - Add minimal `README.md` (one-paragraph pitch + status badge placeholder + stack)
  - Add `LICENSE` (MIT unless user specifies otherwise — ask first)
  - Add `.gitignore` covering: Node (`node_modules`, `dist`, `.vite`), Python (`__pycache__`, `.venv`, `*.egg-info`, `.pytest_cache`, `.ruff_cache`), Rust/Tauri (`target/`, `Cargo.lock` keep), macOS (`.DS_Store`), env (`.env`, `.env.local`), IDE (`.vscode/`, `.idea/`)
  - Commit `CLAUDE.md` and `ROADMAP.md` (this file)
  - Create empty directories with `.gitkeep`: `apps/desktop`, `apps/api`, `packages/shared-types`, `docs/adr`
- **Acceptance:**
  - [x] Repo cloneable from GitHub
  - [x] `main` is the default branch
  - [x] Initial commit message is `chore: initial repository setup` _(actual: `chore: initial repository setup with Claude Code workspace` — pre-dated this task; message follows Conventional Commits)_

### 0.2 Branch protection on `main`

- [x] Branch: `chore/branch-protection` (or done from GitHub UI then committed as a doc)
- **Steps:**
  - Configure via `gh api` or repo settings:
    - Require PR before merging
    - Require 1 approving review (self-approval allowed since solo dev — adjust if team grows)
    - Dismiss stale approvals on new commits
    - Require status checks: `lint`, `typecheck`, `test-frontend`, `test-backend`, `coverage-gate`, `build-check` (these come online in 0.4 — set to required progressively)
    - Require conversation resolution
    - Require linear history (squash-merge only)
    - Block force pushes
    - Block deletions
  - Document the configuration in `docs/adr/0001-branch-protection.md`
- **Acceptance:**
  - [x] `git push origin main` from a fresh clone is rejected
  - [x] ADR present and dated

### 0.3 Pre-commit framework + commitlint

- [x] Branch: `chore/pre-commit`
- **Steps:**
  - Add `.pre-commit-config.yaml` with hooks:
    - `pre-commit-hooks`: `trailing-whitespace`, `end-of-file-fixer`, `check-yaml`, `check-json`, `check-merge-conflict`, `mixed-line-ending`
    - `prettier` (TS/TSX/JSON/MD/YAML)
    - `eslint` (when frontend exists; gate behind file pattern so it's skipped on first run)
    - `ruff` (format + check on Python files)
    - `rustfmt` (on Rust files via `cargo fmt`)
    - `gitleaks` for secret detection
    - `commitlint` on `commit-msg` stage
  - Add `commitlint.config.js` referencing `@commitlint/config-conventional`
  - Add `package.json` at repo root (private, workspaces) with dev deps for prettier/eslint/commitlint
  - Add a `Makefile` or `scripts/setup-dev.sh` that runs `pre-commit install` + `pre-commit install --hook-type commit-msg`
  - Document in `README.md`: "Run `make setup` after clone"
- **Acceptance:**
  - [x] `pre-commit run --all-files` exits 0 on a clean repo
  - [x] A commit with message `bad message` is rejected
  - [x] A staged file containing a fake API key (e.g. `AKIA...`) is blocked by gitleaks
  - [x] Pre-commit doc added to `README.md`

### 0.4 CI pipeline — PR gate

- [x] Branch: `chore/ci-pr-gate`
- **File:** `.github/workflows/ci.yml`
- **Triggers:** `pull_request`, `push` to non-`main` branches
- **Concurrency:** cancel in-progress on new push for same ref
- **Jobs (matrix where useful):**
  - `lint` — runs prettier --check, eslint, ruff check, cargo fmt --check, cargo clippy
  - `typecheck` — `pnpm -r typecheck`
  - `test-frontend` — vitest with `--coverage`, upload to Codecov (or PR comment via `vitest-coverage-report-action`)
  - `test-backend` — pytest with `--cov`, upload coverage
  - `test-tauri` — `cargo test` in `apps/desktop/src-tauri`
  - `coverage-gate` — fails if combined coverage < 70%
  - `build-check` — `pnpm tauri build --debug` on `macos-14` (Apple Silicon runner)
- **Caching:** pnpm store, uv cache, cargo registry + target
- **Acceptance:**
  - [x] Open a draft PR with a trivial change → all jobs run and pass
  - [x] All jobs added to required status checks (update branch protection)
  - [x] CI runs in under 10 minutes on a small change (cache hit path)

### 0.5 Release-please

- [x] Branch: `chore/release-please`
- **Files:**
  - `.github/workflows/release-please.yml` (triggers on push to `main`)
  - `release-please-config.json` — manifest mode, single component, `release-type: simple`, generate `CHANGELOG.md`, tag format `v${version}`
  - `.release-please-manifest.json` — initial `{"./" : "0.0.0"}`
- **Steps:**
  - Create a GitHub App or fine-grained PAT with `contents:write` + `pull_requests:write`, store as `RELEASE_PLEASE_TOKEN`
  - Configure release-please to bump version in `apps/desktop/src-tauri/tauri.conf.json` and `apps/desktop/package.json` and `apps/api/pyproject.toml` via `extra-files`
- **Acceptance:**
  - [x] After this PR merges, no release PR is opened (no feat/fix yet)
  - [x] Document the release flow in `docs/adr/0002-release-strategy.md`

### 0.6 Issue + PR templates + CODEOWNERS

- [x] Branch: `chore/templates`
- **Files:**
  - `.github/PULL_REQUEST_TEMPLATE.md` — sections: Linked task, Summary, Changes, Tests, Checklist (lint/typecheck/tests/coverage/docs/ROADMAP updated)
  - `.github/ISSUE_TEMPLATE/bug.yml` — structured form
  - `.github/ISSUE_TEMPLATE/feature.yml` — structured form
  - `.github/ISSUE_TEMPLATE/config.yml` — disable blank issues
  - `.github/CODEOWNERS` — repo owner as default; granular paths can come later
- **Acceptance:**
  - [x] Opening a new issue from GitHub UI shows bug/feature choice
  - [x] New PR auto-fills the template

### 0.7 Dependency hygiene — Dependabot

- [x] Branch: `chore/dependabot`
- **File:** `.github/dependabot.yml`
- **Ecosystems:** `npm`, `pip` (and/or `uv`), `cargo`, `github-actions`
- **Config:** weekly schedule, group minor+patch updates per ecosystem, allow up to 5 open PRs per ecosystem, target `main`
- **Acceptance:**
  - [x] Dependabot opens at least one update PR within a week (or manually triggered to verify)

### 0.8 Security baseline

- [x] Branch: `chore/security`
- **Files:**
  - `.github/workflows/codeql.yml` — CodeQL for `javascript-typescript`, `python`. Schedule weekly + on PR to `main`.
  - `SECURITY.md` — disclosure policy, contact
- **Repo settings (document in ADR):**
  - Enable secret scanning + push protection
  - Enable Dependabot alerts
  - Enable private vulnerability reporting
- **Acceptance:**
  - [x] CodeQL job runs and passes on a PR
  - [x] `SECURITY.md` linked from README

### 0.9 Claude Code workspace setup

- [x] Branch: `chore/claude-workspace`
- **Files (most are pre-built — see deliverables from initial planning session):**
  - `.claude/settings.json` — permissions (allow/deny/ask), hooks for auto-format & main-push protection, MCP servers (context7, github, sequential-thinking)
  - `.claude/agents/architecture-keeper.md` — hexagonal boundaries + IPC contract + ADR discipline
  - `.claude/agents/security-auditor.md` — full security review
  - `.claude/agents/design-reviewer.md` — UI/UX/a11y/macOS HIG
  - `.claude/agents/caveman-reviewer.md` — ultra-terse one-line review (model: haiku)
  - `.claude/commands/start-task.md` — read task, create branch, summarize before coding
  - `.claude/commands/wrap-pr.md` — run gates, invoke reviewers, update ROADMAP, open PR
  - `.claude/commands/sync.md` — rebase on main
- **MCP setup (one-time, on user's machine):**
  - `claude mcp add context7 -- npx -y @upstash/context7-mcp@latest`
  - `claude mcp add github -- npx -y @modelcontextprotocol/server-github` (set `GITHUB_PERSONAL_ACCESS_TOKEN` in shell)
  - `claude mcp add sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking`
  - Verify with `claude mcp list`
- **Optional plugins to evaluate (user decides whether to install):**
  - [`caveman`](https://github.com/JuliusBrussee/caveman) — token-compression skill for output. Best installed at user level (`~/.claude/`), not project level.
  - [`agent-caveman`](https://github.com/carlet0n/agent_caveman) — compression on the orchestrator↔subagent channel.
- **Acceptance:**
  - [x] All files in `.claude/` committed
  - [x] `claude mcp list` shows context7, github, sequential-thinking
  - [x] `/start-task 1.1` runs end-to-end on a fresh checkout (manual verification — proven throughout Phase 0)
  - [x] PostToolUse formatting hook fires on a test edit (verified — every commit in Phase 0 was auto-formatted)
  - [x] PreToolUse hook blocks `git push origin main` (verified — deny rule fires on every direct push attempt)

---

## Phase 1 — Skeleton

> Goal: a runnable empty app with frontend, sidecar, and IPC working end-to-end. No ML yet.

### 1.1 Tauri + React + Vite scaffold

- [x] Branch: `feat/desktop-scaffold`
- Use `pnpm create tauri-app` with React + TS + Vite template, place in `apps/desktop/`
- Add Tailwind, configure paths, add a single placeholder screen ("Interior Vision — Hello")
- Configure Vitest + Testing Library, write one trivial test
- **Acceptance:**
  - [x] `pnpm tauri dev` opens a window on macOS
  - [x] `pnpm tauri build` produces a `.app` bundle
  - [x] CI build-check passes

### 1.2 Python FastAPI sidecar scaffold

- [x] Branch: `feat/api-scaffold`
- Set up `apps/api/` with `uv init`, FastAPI, uvicorn, pydantic-settings, structlog
- Single endpoint: `GET /health` returning `{"status": "ok", "version": "..."}`
- pytest + httpx test for the endpoint
- `pyproject.toml` with ruff config (line-length 100, target-version py312)
- **Acceptance:**
  - [x] `uv run uvicorn app.main:app` starts and responds to `/health`
  - [x] Tests pass with coverage > 80% on this small surface

### 1.3 Tauri sidecar integration

- [x] Branch: `feat/sidecar-integration`
- Bundle the Python sidecar with PyInstaller (one-folder mode) into a binary committed via build script — _or_ use `uv tool install` at runtime (write an ADR comparing both)
- Configure Tauri to launch the sidecar on app start, terminate on app quit, on a free localhost port
- Expose a Tauri command `apiBaseUrl()` to the frontend
- Write a doc `docs/IPC.md` describing the contract
- **Acceptance:**
  - [x] Tauri app starts, sidecar starts, frontend can call `/health` through the URL returned by `apiBaseUrl()`
  - [x] Sidecar process is killed when app quits (verified on macOS)
  - [x] ADR `0003-sidecar-packaging.md` written

### 1.4 Shared types codegen

- [x] Branch: `feat/shared-types`
- Use `datamodel-code-generator` or `pydantic-to-typescript` to generate TS types from pydantic models in `apps/api`
- Output to `packages/shared-types/`, consumed by `apps/desktop`
- Add a `pnpm codegen` script and CI check that fails if generated types are stale
- **Acceptance:**
  - [x] Modifying a pydantic model and running `pnpm codegen` updates the TS file
  - [x] CI fails if codegen is not run

### 1.5 Logging + structured errors

- [x] Branch: `feat/observability`
- Frontend: a `logger` wrapper around `console` that ships logs to the sidecar `/logs` endpoint
- Backend: structlog with JSON output in prod, human-readable in dev, request-id middleware
- Frontend error boundary that shows a friendly screen and logs the error
- **Acceptance:**
  - [x] Errors thrown in React land in backend logs with a correlation ID
  - [x] Test asserting that an unhandled FastAPI exception returns a structured JSON error

---

## Phase 2 — ML Pipeline V1 (cloud) — Capture & Préparation

> Goal: end-to-end "upload room + object → faithful proxy composite". Implements step 1 of the workflow (scene preprocessing + object background removal) and the proxy-side of step 3 (deterministic composite). Quality is "good enough to demo", harmonisation is left to Phase 5.

### 2.1 fal.ai client + secrets handling

- [x] Branch: `feat/fal-client`
- Settings: `FAL_KEY` from env, validated by pydantic-settings, surfaced in app via a Settings screen later
- Thin async client wrapper around `fal-client` SDK with timeouts, retries (tenacity), error normalization
- All ML calls go through this client — no direct fal.ai usage elsewhere
- **Acceptance:**
  - [x] Unit tests with mocked fal responses (success, timeout, rate limit, malformed payload)
  - [x] Optional `@pytest.mark.live` test gated by env var

### 2.2 Endpoint: scene preprocessing

- [x] Branch: `feat/scene-preprocessing`
- `POST /scenes/preprocess` — accepts an image, calls Depth Anything V2 + SAM 2 on fal.ai, returns depth map URL + segmentation masks + scene metadata (estimated dominant surface, lighting hint)
- Cache results keyed by image SHA-256 for the lifetime of a project (filesystem cache in `~/Library/Caches/InteriorVision/scenes/<hash>/`)
- **Acceptance:**
  - [x] Same image uploaded twice → second call is cache hit (< 50 ms)
  - [x] Tests cover cache hit/miss and corrupted-cache recovery

### 2.3 Endpoint: object extraction

- [x] Branch: `feat/object-extraction`
- `POST /objects/extract` — image of an object → cleanly masked PNG with transparency (BiRefNet on fal.ai; `fal-ai/bria/remove-background` is a drop-in fallback)
- Same caching strategy as 2.2
- **Acceptance:**
  - [x] Test fixtures: 5 reference furniture images, visual regression check on masks

### 2.4 Endpoint: composition (proxy v0 — Flux Fill, superseded by 4.4)

- [x] Branch: `feat/composition`
- `POST /compose` — body: scene_id, object_id, placement (bbox + depth hint), style hints
- Pipeline: build placement mask from bbox+depth → call Flux Fill conditioned by Redux on object image → optional ControlNet Depth → return result image URL
- **Acceptance:**
  - [x] Visual smoke test on 3 fixture scenes — output looks broadly correct (manual review checklist in PR)
  - [x] Latency budget documented (<= 15s p95 for 1024x1024)
- **Note:** the Flux Fill path was replaced in task 4.4 by deterministic PIL compositing (see ADR-0007). The generative harmonisation use case is reborn as the explicit Harmonizer endpoint in Phase 5.

### 2.5 E2E test from sidecar perspective

- [x] Branch: `test/e2e-pipeline`
- A pytest test that uploads a fixture room + fixture chair and asserts a composed image is produced (skipped unless `FAL_KEY` set — gated job in CI with secret)
- **Acceptance:**
  - [x] CI has an opt-in `e2e` job that runs on label `run-e2e` or weekly schedule

---

## Phase 3 — UI Workflow

> Goal: a designer-friendly UX from upload to result. Implements step 2 of the workflow (canvas interaction).

### 3.1 Upload screen — room photo

- [x] Branch: `feat/upload-room`
- Drag-and-drop + file picker, preview, EXIF orientation handling, max size guard
- On upload, kick off scene preprocessing in background; show progress
- **Acceptance:**
  - [x] Tested with HEIC, JPEG, PNG inputs
  - [x] Visual regression test (Storybook + Chromatic, or Playwright screenshot)

### 3.2 Add objects panel

- [x] Branch: `feat/object-library`
- Side panel listing uploaded objects with thumbnails (auto-extracted)
- Drag from panel onto canvas to place
- **Acceptance:**
  - [x] Add/remove/rename objects, persisted per-project locally (SQLite via `better-sqlite3` in Rust side)

### 3.3 Canvas + interactive placement

- [x] Branch: `feat/canvas-placement`
- Konva.js or Pixi.js canvas overlaying the room photo
- Drag, scale, rotate placeholder; depth hint via slider; snap to detected surfaces (use scene metadata from 2.2)
- **Acceptance:**
  - [x] Pixel-precise placement persisted, restorable on reload
  - [x] Keyboard shortcuts documented

### 3.4 Render trigger + result view

- [x] Branch: `feat/render-flow`
- "Render" button → composition request → loading state with intermediate previews if available → result panel with before/after slider
- Save result to project history
- **Acceptance:**
  - [x] Cancel mid-render works (request aborted server-side)
  - [x] Failed render shows actionable error

### 3.5 Fix scene segmentation endpoint (SAM2 replacement)

- [x] Branch: `fix/sam2-endpoint`
- `fal-ai/sam2` (everything/automatic mode) was removed from fal.ai. Replaced with `fal-ai/sam` (YOLO-World + SAM) which returns a colour-coded segmentation PNG. Per-region bboxes extracted via Pillow single-pass colour grouping. `fal.fetch_bytes` added to `AsyncFalClient` for SSRF-safe CDN downloads.
- **Acceptance:**
  - [x] `run_preprocessing` returns ≥ 1 mask with a valid bbox on a standard room photo
  - [x] `dominant_surface` is no longer `"unknown"` for typical interiors
  - [x] Snap-to-surface in PlacementCanvas works for at least one detected surface
  - [x] Existing preprocessing tests updated for the new response format

### 3.6 Project history + multi-iteration

- [ ] Branch: `feat/project-history`
- Sidebar listing prior renders for current project, click to compare
- Export final image as PNG with metadata
- **Acceptance:**
  - [ ] Export round-trips correctly (open in Preview shows expected image)

---

## Phase 4 — Polish (proxy faithfulness)

> Goal: turn the demo-quality pipeline into a faithful, robust proxy editor. Closes the loop on steps 1–3 of the workflow with deterministic behaviour and good UX.

### 4.1 Two-pass rendering (preview → final)

- [x] Branch: `feat/two-pass-render`
- Use Flux Schnell (fewer steps, ~1-2s) for live preview during placement; trigger Flux Fill Dev only on explicit "Render" click
- **Acceptance:**
  - [x] Preview latency < 3s p95
  - [x] User-perceptible quality jump on final render
- **Note:** the two-pass distinction has since collapsed into a single PIL composite (task 4.4). The two-pass model returns in Phase 5 as `proxy → harmonize`.

### 4.2 Settings panel

- [x] Branch: `feat/settings`
- Manage `FAL_KEY`, default render quality, cache size, telemetry opt-in
- Persist with `tauri-plugin-store`
- **Acceptance:**
  - [x] Invalid API key surfaces a clear error before first render

### 4.3 Robust error states + retry UX

- [x] Branch: `feat/error-ux`
- Map all backend error codes to user-friendly messages with retry CTAs
- Offline detection
- **Acceptance:**
  - [x] Manual test matrix: kill sidecar, drop wifi, expire API key — each shows the right state

### 4.4 Faithful PIL compositing (replaces Flux Fill for placement)

- [x] Branch: `feat/faithful-compositing`
- The original `/compose` path passed only a binary mask + prompt to Flux Fill — the object PNG was never sent. The model hallucinated a furniture-shaped region inspired by the prompt, not the user's actual object. Fix: replace the generative inpainting call with PIL alpha-compositing using the BiRefNet-extracted PNG. The result is the exact object placed at the user's chosen position, scale, and rotation. Adds `rotation` to `PlacementSpec` (Konva already tracks it), `.fal.media` to the SSRF allowlist for `fetch_bytes`, and returns a base64 JPEG data URL instead of a fal.ai CDN URL. Both `/compose` and `/compose/preview` share the same logic.
- **Acceptance:**
  - [x] `/compose` returns a JPEG data URL containing the user's exact object at the requested bbox + rotation
  - [x] No fal.ai inference call is made by `/compose` (only `fetch_bytes` for the extracted PNG)
  - [x] Preview is near-instant (no Flux Schnell round-trip)
  - [x] All offline composition/preview tests pass + e2e test updated

### 4.5 Smart auto-placement by object type + soft shadow rendering

- [x] Branch: `feat/smart-placement`
- When the user adds an object the app should detect whether it's wall-mounted (painting, frame, mirror) or floor-standing (furniture, plant, lamp) and auto-position it on the appropriate detected surface, at a sensible initial scale. The user can still drag/scale freely afterwards or toggle the type via a badge in the object panel. Adds a parallel Moondream2 classification call alongside BiRefNet during extraction (zero added latency), labels the dominant wall/floor masks during preprocessing (only the largest mask in each image half is tagged), and renders soft shadows in PIL (elliptical ground shadow for floor objects, drop-shadow for wall objects) for visual integration.
- **Acceptance:**
  - [x] `POST /objects/extract` returns `object_type` ∈ {`wall`, `floor`}; falls back to `floor` if Moondream is unavailable
  - [x] `POST /scenes/preprocess` returns masks with `surface_type` ∈ {`wall`, `floor`, `unknown`}; at most one of each
  - [x] Placing a wall object auto-snaps to the wall mask centroid at ~35% of wall width
  - [x] Placing a floor object auto-snaps to the floor mask centroid at ~20% of floor width
  - [x] Multiple objects of the same surface type don't stack — they offset horizontally
  - [x] ObjectPanel shows a Wall/Floor badge; click toggles the type and persists via SQLite migration v4
  - [x] Rendered composite shows an elliptical ground shadow under floor objects or a drop-shadow behind wall objects

### 4.6 Telemetry (opt-in, anonymous)

- [x] Branch: `feat/telemetry`
- Use Plausible or PostHog with opt-in consent
- Events: `render_started`, `render_completed`, `render_failed`, `harmonize_started`, `harmonize_completed`, `harmonize_failed` with duration and error class only — never image content
- **Acceptance:**
  - [x] Opt-out fully disables network calls (verified via packet capture or unit test on the wrapper)

### 4.7 Pluggable background-removal driver

- [x] Branch: `feat/bg-removal-driver`
- Goal: decouple `/objects/extract` from any single fal.ai model so we can A/B-test `BiRefNet` against `fal-ai/bria/remove-background` on real decoration objects and keep the option to add more drivers later — without rewiring the object pipeline. Today `apps/api/app/objects/extraction.py` calls BiRefNet directly through `AsyncFalClient`; this is what 4.7 abstracts away.
- **Steps:**
  - Introduce a `BackgroundRemovalDriver` protocol in `apps/api/app/objects/background_removal/__init__.py` with a single async method `async def remove(self, image_bytes: bytes, *, content_type: str) -> ExtractionResult` returning the existing extraction result shape (PNG URL + metadata). All fal.ai SDK access stays funnelled through `app/cloud/fal_client.py` (architecture-keeper enforces).
  - Implement two concrete drivers:
    - `BiRefNetDriver` — moves today's logic out of `extraction.py` without behaviour change.
    - `BriaDriver` — calls `fal-ai/bria/remove-background` and normalises its response to the same `ExtractionResult` shape (PNG with alpha; same caching key strategy).
  - Resolve the active driver at startup via pydantic-settings: `BG_REMOVAL_BACKEND ∈ {"birefnet", "bria"}`, defaulting to `"birefnet"` so existing behaviour is preserved. Surface the active backend in `GET /health` for diagnostics.
  - Wire the driver into `apps/api/app/objects/extraction.py` via dependency injection (so tests can pass a fake driver).
  - Document the abstraction in `docs/ML_PIPELINE.md` and update the "Vision technique" pointer above.
- **Acceptance:**
  - [x] `BG_REMOVAL_BACKEND=birefnet` (or unset) yields identical output bytes to the pre-refactor pipeline on the 5 fixture objects from task 2.3 (regression: hash-compare the cached PNGs)
  - [x] `BG_REMOVAL_BACKEND=bria` round-trips the same 5 fixtures and produces a valid alpha-channel PNG (mocked fal response in unit tests; one `@pytest.mark.live` integration test gated on `FAL_KEY`)
  - [x] An invalid value for `BG_REMOVAL_BACKEND` fails startup with a clear pydantic-settings error
  - [x] `architecture-keeper` agent passes — no fal SDK import outside `app/cloud/`
  - [x] `pnpm codegen` is a no-op (no schema change leaks to the frontend)
  - [x] Coverage on the new driver layer ≥ 85%

---

## Phase 5 — AI Harmonizer (photoreal final render)

> Goal: implement step 4 of the workflow. Take the faithful PIL proxy from Phase 4 and run it through a generative harmonisation pass (Flux Fill img2img + ControlNet Depth, with SDXL img2img as fallback) so cast shadows, perspective, light bounce, and edge integration look natural — while keeping the user's exact object pixels recognisable. Splits cleanly into three sub-tracks:
>
> - **Canvas UI track** — tasks 5.1, 5.2, 5.5
> - **Python backend / fal.ai orchestration track** — tasks 5.3, 5.4
> - **AI rendering polish track** — tasks 5.6, 5.7
> - **Scene cleanup track (optional pre-placement step)** — tasks 5.8, 5.9, 5.10

### 5.1 Object duplication on canvas (UI track)

- [x] Branch: `feat/canvas-duplicate`
- Add a "duplicate" affordance to placed objects: Cmd/Ctrl+D shortcut, right-click context-menu entry, and a duplicate icon in the floating selection toolbar. Duplicated nodes appear offset by ~24 px on both axes, become the new selection, and inherit the source object's `object_id`, surface_type, scale, and rotation. The auto-stacking rule from task 4.5 still applies so duplicates do not visually overlap their source.
- **Files:** `apps/desktop/src/components/PlacementCanvas.tsx`, `apps/desktop/src/lib/placements.ts`, keyboard shortcuts doc.
- **Acceptance:**
  - [x] Cmd/Ctrl+D on a selected placement creates a new placement that round-trips through SQLite persistence
  - [x] Right-click → Duplicate on the canvas produces the same result
  - [x] Duplicating an object three times yields four non-overlapping placements
  - [x] Vitest coverage on the duplication helper + Playwright/Tauri smoke test on the shortcut _(no Playwright setup in project — covered by Vitest + Testing Library; 6 new tests in PlacementCanvas.test.tsx)_

### 5.2 Render-mode toggle in the result view (UI track)

- [x] Branch: `feat/render-modes`
- The result view gains a two-state toggle: **Proxy** (current PIL composite, instant) and **Harmonize** (calls the new endpoint, ~10–25 s). Default stays on Proxy. The toggle is disabled while a harmonisation is in-flight, and the before/after slider compares Proxy vs Harmonize when both are available.
- **Files:** `apps/desktop/src/components/ResultView.tsx`, `apps/desktop/src/lib/api.ts`, `apps/desktop/src/test/`.
- **Acceptance:**
  - [x] Switching modes never causes the wrong image to flash (race condition guarded)
  - [x] Harmonize call can be cancelled and the toggle returns to Proxy
  - [x] States covered: idle, harmonising, success, failure (with retry CTA), offline

### 5.3 Proxy export endpoint — composite + B/W mask (backend track)

- [ ] Branch: `feat/proxy-export`
- Extend `/compose` (or add `/compose/proxy`) to return both:
  - the existing composited JPEG (`url`, base64 data URL),
  - a **binary B/W mask** (`mask_url`, PNG data URL) where white pixels mark the union of all placed objects' alpha footprints (after rotation/scale), black is background.
    Also returns `depth_map_url` (proxied from the cached scene preprocessing) so the Harmonizer can feed a ControlNet without re-running Depth Anything. Update `packages/shared-types` via `pnpm codegen`.
- **Files:** `apps/api/app/compose/composition.py`, `apps/api/app/compose/router.py`, `apps/api/app/schemas.py`, `packages/shared-types/`, pytest fixtures.
- **Acceptance:**
  - [ ] Response contains `composite_url`, `mask_url`, `depth_map_url` and the existing `url` alias for back-compat
  - [ ] Mask is strictly binary (only 0 and 255), same resolution as the composite
  - [ ] Mask round-trips through PIL + numpy in tests with no anti-aliasing leakage
  - [ ] No fal.ai inference call added (mask is computed locally; depth map is fetched from cache)

### 5.4 Harmonizer endpoint — Flux Fill img2img + ControlNet Depth (backend track)

- [ ] Branch: `feat/harmonizer-endpoint`
- New endpoint `POST /compose/harmonize`. **Primary pipeline (High Fidelity, default): Flux Fill img2img + ControlNet Depth — this is the product's core value proposition, the path that defeats the "copy-paste" effect.** SDXL img2img is an opt-in cost-optimisation fallback only, never the default. Request body: `scene_id`, list of `object_id`s currently placed, `placement` map (for cache key), `harmonize_strength ∈ [0.15, 0.55]` **(required field — no server-side default; the slider in 5.5 also has no pre-selected value until task 5.6 lands one, possibly per object type)**, `seed?`. Pipeline:
  1. Fetch (or generate) the proxy composite + mask + depth map via task 5.3.
  2. **Primary path** — call `AsyncFalClient.run("fal-ai/flux-pro/v1/fill", ...)` with the composite as `image_url`, the B/W mask, a depth-conditioned ControlNet, the request's `harmonize_strength`, and a fixed harmonisation prompt suffix ("preserve object identity, integrate lighting and cast shadows naturally, photorealistic interior, no new objects").
  3. **Fallback path** — engaged only when `HARMONIZER_BACKEND=sdxl`: SDXL img2img call routed through the same client. Default is `HARMONIZER_BACKEND=flux`.
  4. Cache result keyed on (scene_sha, sorted placements, backend, strength, seed) in `~/Library/Caches/InteriorVision/harmonize/<hash>/`.
  5. All fal.ai calls go through `app/cloud/fal_client.py` — `architecture-keeper` must pass on the PR.
- **Files:** `apps/api/app/compose/harmonize.py` (new), `apps/api/app/compose/router.py`, `apps/api/app/schemas.py`, `apps/api/tests/test_harmonize.py` (new).
- **Acceptance:**
  - [ ] Mocked fal response → endpoint returns a JPEG data URL inside the success envelope
  - [ ] Cache hit on identical inputs is < 50 ms; miss path is observed in tests
  - [ ] Timeout, rate-limit, malformed-payload, and SDXL-fallback paths all covered by tests
  - [ ] Latency budget documented: p95 ≤ 25 s for 1024×1024 on Flux Fill, ≤ 15 s on SDXL
  - [ ] No fal SDK import outside `app/cloud/`

### 5.5 Harmonize flow in the UI (UI track)

- [ ] Branch: `feat/harmonize-flow`
- Wire the toggle from 5.2 to the endpoint from 5.4. Show staged progress ("compositing → masking → harmonising"). Surface a `harmonize_strength` slider directly in the result view, clamped to the backend's `[0.15, 0.55]` range. **No default value is pre-selected until task 5.6 produces one** — the slider sits at its midpoint with a tooltip pointing to the bench task. Persist last-used strength per project in the settings store.
- **Files:** `apps/desktop/src/components/ResultView.tsx`, `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/settingsStore.ts`.
- **Acceptance:**
  - [ ] Happy path: click Harmonize → spinner → harmonised image appears, before/after slider compares to proxy
  - [ ] Cancel mid-harmonise aborts the request server-side (verified in test)
  - [ ] Errors from 5.4 are mapped via the matrix from task 4.3
  - [ ] `design-reviewer` agent approves the layout and a11y of the new controls

### 5.6 Harmonizer quality + latency tuning (AI polish track)

- [ ] Branch: `chore/harmonizer-tuning`
- A/B harness: a `scripts/harmonizer_bench.py` that runs the endpoint on 10 fixture (room, objects, placement) triplets across a grid of `strength × controlnet_weight × backend`, **split by object type (wall vs floor)** so the recommended `harmonize_strength` can differ per surface. Outputs a CSV of latency + a contact-sheet PNG for visual review. Also tune the prompt suffix to minimise object hallucination at higher strengths. **This task is what produces the recommended `harmonize_strength` default value(s) — possibly per object type — that then ship as the in-code default in `app/compose/harmonize.py` and as the slider pre-selection in 5.5.**
- **Files:** `apps/api/scripts/harmonizer_bench.py`, `apps/api/tests/fixtures/harmonize/`, results doc under `docs/`.
- **Acceptance:**
  - [ ] Bench runs end-to-end with `FAL_KEY` set, gated behind `@pytest.mark.live` and a `run-bench` label in CI
  - [ ] Recommended `harmonize_strength` default(s) committed in `apps/api/app/compose/harmonize.py` (single value or `{wall: x, floor: y}`) and wired into the UI slider pre-selection in 5.5
  - [ ] Visual contact-sheet attached to the PR with side-by-side outputs at the chosen defaults vs neighbouring strength values
  - [ ] Latency p95 budget from 5.4 met on the chosen defaults (Flux primary path)

### 5.7 ADR-0008 — AI Harmonizer pipeline (AI polish track)

- [ ] Branch: `docs/adr-0008-harmonizer`
- Document: why a second generative pass is reintroduced after ADR-0007, the proxy-then-harmonize contract (object identity preserved by low strength + mask), the chosen backend(s) and tuning, and the boundary with `app/cloud/fal_client.py`. Reference task 5.6 results.
- **Acceptance:**
  - [ ] ADR file present at `docs/adr/0008-ai-harmonizer.md`
  - [ ] Cross-linked from ADR-0007 and from the "Vision technique" section of this file
  - [ ] `architecture-keeper` agent reviews and accepts

### 5.8 Scene cleanup endpoint — inpainting-based erase (Scene cleanup track)

- [ ] Branch: `feat/scene-clean-endpoint`
- New endpoint `POST /scenes/clean`. Request body: `scene_id`, a binary B/W `mask` (PNG data URL — white = pixels to erase, black = keep), optional `prompt_hint` for the inpainter's context (e.g., "empty floor", "blank wall"). Pipeline:
  1. Fetch the scene image from the scenes cache (no re-upload required).
  2. **Primary path** — call `AsyncFalClient.run("fal-ai/lama", ...)` (LaMa inpainting — fast, deterministic, designed for object removal; no prompt steering, hallucination-free).
  3. **Fallback path** — engaged when `SCENE_CLEAN_BACKEND=flux`: use Flux Fill in erase mode with the prompt hint. Default is `SCENE_CLEAN_BACKEND=lama`.
  4. Validate the mask: must be the exact resolution of the source scene, strictly binary, ≤ 20% of total pixels (safety rail against accidentally wiping the whole room).
  5. Cache result keyed on (scene_sha, mask_sha, backend) in `~/Library/Caches/InteriorVision/scenes-clean/<hash>/`. Returns a fresh `cleaned_scene_id` that subsequent `/compose` calls accept in place of the original `scene_id`.
  6. All fal.ai calls go through `app/cloud/fal_client.py` — `architecture-keeper` must pass.
- **Files:** `apps/api/app/scenes/cleanup.py` (new), `apps/api/app/scenes/router.py`, `apps/api/app/schemas.py`, `apps/api/tests/test_scene_cleanup.py` (new), `packages/shared-types/` (regenerated).
- **Acceptance:**
  - [ ] Mocked LaMa response → endpoint returns `{cleaned_scene_id, cleaned_url, content_type}`
  - [ ] Mask validation rejects: wrong-resolution, non-binary, > 20% coverage, missing
  - [ ] Cache hit on identical inputs is < 50 ms; miss path observed in tests
  - [ ] Timeout / rate-limit / malformed-response paths covered
  - [ ] Latency budget: p95 ≤ 8 s for 1024×1024 on LaMa
  - [ ] No fal SDK import outside `app/cloud/`

### 5.9 Canvas "remove existing decor" mode (Scene cleanup track)

- [ ] Branch: `feat/canvas-erase-mode`
- New canvas mode toggle: **Place** (current default) ↔ **Erase**. In Erase mode the canvas overlays the SAM masks from `/scenes/preprocess` (already cached). The user clicks a region to add it to the erase selection (selected regions glow red), clicks again to deselect, then presses **Clean** to call `/scenes/clean` with the union of selected masks. Once a clean variant exists, a "Use cleaned scene" pill appears at the top of the canvas — clicking it swaps the working scene; an "Original" toggle reverts. Free brush / lasso selection is **out of scope** for this task and is recorded in the backlog.
- **Files:** `apps/desktop/src/components/PlacementCanvas.tsx`, `apps/desktop/src/components/CanvasToolbar.tsx` (new), `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/sceneStore.ts`, keyboard shortcuts doc.
- **Acceptance:**
  - [ ] Toggling between Place and Erase preserves placed objects (they fade to 40% opacity in Erase mode)
  - [ ] Clicking a SAM region toggles its selection; the union mask sent to the backend is the OR of all selected regions, rasterised at the scene's native resolution
  - [ ] Clean button is disabled when no region is selected or the union exceeds the backend's 20% safety rail (with a tooltip explaining why)
  - [ ] After a successful clean, the canvas swaps to the cleaned scene and a "Restore original" affordance is available; both states are persisted in the project
  - [ ] Failure paths use the error matrix from task 4.3
  - [ ] `design-reviewer` agent approves the layout and a11y

### 5.10 Scene variant persistence + history surfacing (Scene cleanup track)

- [ ] Branch: `feat/scene-variants`
- Per-project SQLite migration (v5) to persist both the original scene and one or more `cleaned_scene_id` variants, including the mask SHA used. The project store now resolves which variant is "active" at any time; existing placements stay valid because they reference the scene by `scene_id` and the cleaned variant inherits the same depth + segmentation cache (the surface masks are still valid on the cleaned image — verified in the test suite, with a fallback to re-running `/scenes/preprocess` if the IoU between the original and cleaned wall/floor masks drops below 0.85). Surfaces a "Scene variants" group in the project history sidebar from task 3.6 (if 3.6 has not yet landed, this task ships its own minimal variant list).
- **Files:** `apps/desktop/src-tauri/migrations/0005_scene_variants.sql` (new), `apps/desktop/src-tauri/src/projects.rs`, `apps/desktop/src/lib/projectStore.ts`, `apps/desktop/src/components/SceneVariantList.tsx` (new).
- **Acceptance:**
  - [ ] Migration v5 applies on a v4 database without data loss
  - [ ] Switching between original and cleaned variants in the UI updates the canvas + persists the choice across app restarts
  - [ ] IoU fallback triggers `/scenes/preprocess` re-run when the cleaned scene materially changes the surface layout
  - [ ] Deleting a project also deletes its cleaned-variant cache entries on disk
  - [ ] Test coverage ≥ 80% on the new persistence layer

---

## Phase 6 — Distribution

### 6.1 macOS code signing

- [ ] Branch: `chore/macos-signing`
- Apple Developer account; Developer ID Application certificate stored as base64 in `MACOS_CERTIFICATE` secret + password in `MACOS_CERTIFICATE_PWD`
- Tauri signing config in `tauri.conf.json`
- **Acceptance:**
  - [ ] `codesign -dv --verbose=4 InteriorVision.app` shows a valid signature

### 6.2 Notarization

- [ ] Branch: `chore/macos-notarization`
- Apple ID + app-specific password as `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` secrets
- `notarytool` invoked from CI on release
- **Acceptance:**
  - [ ] Downloaded `.dmg` from a release runs without Gatekeeper warning on a clean Mac

### 6.3 Tauri auto-updater

- [ ] Branch: `feat/auto-updater`
- Generate updater keys, store public key in `tauri.conf.json`, private key as secret
- Release workflow uploads `latest.json` manifest as a release asset
- **Acceptance:**
  - [ ] Bumping version + releasing triggers update prompt in a previously installed dev build

### 6.4 First public release v1.0.0

- [ ] Branch: covered by release-please PR
- Polish README, screenshots, demo video link
- Verify CHANGELOG is meaningful
- **Acceptance:**
  - [ ] Release page on GitHub has signed `.dmg`, signed `.app.tar.gz` for updater, and `latest.json`
  - [ ] Install on a fresh Mac, complete a full upload→proxy→harmonize flow without issue

---

## Backlog (post-v1, not yet planned)

- Local preprocessing via CoreML (Depth Anything V2 Small + SAM 2 Small) to reduce cloud round-trips
- Local Harmonizer via CoreML (Flux Schnell / SDXL-Turbo) for fully offline final renders
- Free brush / lasso selection for scene cleanup (task 5.9 ships click-on-SAM-region selection only)
- Auto-detect "removable clutter" suggestions on scene preprocessing (heuristic on SAM masks + scene metadata)
- Windows + Linux builds
- Multi-object batch composition with per-object harmonisation tuning
- `depth_hint`-driven perspective correction for floor objects placed at varying depths (revisits the `PlacementSpec.depth_hint` field, currently accepted but unused — see ADR-0007)
- Style transfer modes ("make this room Scandinavian")
- 3D scene reconstruction via Gaussian Splatting from a single photo
- Furniture catalog with shoppable links
- Collaboration / shared projects
- Mobile companion app for capture

---

## Notes for Claude Code

- When in doubt about a task's scope, propose a split rather than expanding scope inside a single PR.
- If you discover a needed task that's missing from this roadmap, add it to the appropriate phase **in the same PR that needs it**, with a comment in the PR description.
- After every merged PR, verify `ROADMAP.md` reflects reality on `main`.
- Phase 5 tasks are sequenced as a tree, not a strict line: 5.1 (canvas duplication) and 5.3 (proxy export) are independent and can ship in parallel. 5.4 depends on 5.3. 5.5 depends on 5.2 and 5.4. 5.6 and 5.7 close the harmonisation work. The Scene cleanup track (5.8 → 5.9 → 5.10) is sequential within itself but **fully independent of the Harmonizer track** — it can ship before, after, or in parallel.
