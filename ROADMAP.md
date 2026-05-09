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

## Phase 2 — ML Pipeline V1 (cloud)

> Goal: end-to-end "upload room + object → realistic composite". Quality is "good enough to demo", not yet polished.

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
- `POST /objects/extract` — image of an object → cleanly masked PNG with transparency (SAM 2 + alpha matting via fal.ai)
- Same caching strategy as 2.2
- **Acceptance:**
  - [x] Test fixtures: 5 reference furniture images, visual regression check on masks

### 2.4 Endpoint: composition

- [x] Branch: `feat/composition`
- `POST /compose` — body: scene_id, object_id, placement (bbox + depth hint), style hints
- Pipeline: build placement mask from bbox+depth → call Flux Fill conditioned by Redux on object image → optional ControlNet Depth → return result image URL
- **Acceptance:**
  - [x] Visual smoke test on 3 fixture scenes — output looks broadly correct (manual review checklist in PR)
  - [x] Latency budget documented (<= 15s p95 for 1024x1024)

### 2.5 E2E test from sidecar perspective

- [x] Branch: `test/e2e-pipeline`
- A pytest test that uploads a fixture room + fixture chair and asserts a composed image is produced (skipped unless `FAL_KEY` set — gated job in CI with secret)
- **Acceptance:**
  - [x] CI has an opt-in `e2e` job that runs on label `run-e2e` or weekly schedule

---

## Phase 3 — UI Workflow

> Goal: a designer-friendly UX from upload to result.

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

## Phase 4 — Polish

### 4.1 Two-pass rendering (preview → final)

- [ ] Branch: `feat/two-pass-render`
- Use Flux Schnell (fewer steps, ~1-2s) for live preview during placement; trigger Flux Fill Dev only on explicit "Render" click
- **Acceptance:**
  - [ ] Preview latency < 3s p95
  - [ ] User-perceptible quality jump on final render

### 4.2 Settings panel

- [ ] Branch: `feat/settings`
- Manage `FAL_KEY`, default render quality, cache size, telemetry opt-in
- Persist with `tauri-plugin-store`
- **Acceptance:**
  - [ ] Invalid API key surfaces a clear error before first render

### 4.3 Robust error states + retry UX

- [ ] Branch: `feat/error-ux`
- Map all backend error codes to user-friendly messages with retry CTAs
- Offline detection
- **Acceptance:**
  - [ ] Manual test matrix: kill sidecar, drop wifi, expire API key — each shows the right state

### 4.4 Telemetry (opt-in, anonymous)

- [ ] Branch: `feat/telemetry`
- Use Plausible or PostHog with opt-in consent
- Events: `render_started`, `render_completed`, `render_failed` with duration and error class only — never image content
- **Acceptance:**
  - [ ] Opt-out fully disables network calls (verified via packet capture or unit test on the wrapper)

---

## Phase 5 — Distribution

### 5.1 macOS code signing

- [ ] Branch: `chore/macos-signing`
- Apple Developer account; Developer ID Application certificate stored as base64 in `MACOS_CERTIFICATE` secret + password in `MACOS_CERTIFICATE_PWD`
- Tauri signing config in `tauri.conf.json`
- **Acceptance:**
  - [ ] `codesign -dv --verbose=4 InteriorVision.app` shows a valid signature

### 5.2 Notarization

- [ ] Branch: `chore/macos-notarization`
- Apple ID + app-specific password as `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` secrets
- `notarytool` invoked from CI on release
- **Acceptance:**
  - [ ] Downloaded `.dmg` from a release runs without Gatekeeper warning on a clean Mac

### 5.3 Tauri auto-updater

- [ ] Branch: `feat/auto-updater`
- Generate updater keys, store public key in `tauri.conf.json`, private key as secret
- Release workflow uploads `latest.json` manifest as a release asset
- **Acceptance:**
  - [ ] Bumping version + releasing triggers update prompt in a previously installed dev build

### 5.4 First public release v1.0.0

- [ ] Branch: covered by release-please PR
- Polish README, screenshots, demo video link
- Verify CHANGELOG is meaningful
- **Acceptance:**
  - [ ] Release page on GitHub has signed `.dmg`, signed `.app.tar.gz` for updater, and `latest.json`
  - [ ] Install on a fresh Mac, complete a full upload→render flow without issue

---

## Backlog (post-v1, not yet planned)

- Local preprocessing via CoreML (Depth Anything V2 Small + SAM 2 Small) to reduce cloud round-trips
- Windows + Linux builds
- Multi-object batch composition
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
