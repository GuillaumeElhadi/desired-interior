# Interior Vision — Project Context

> **You are Claude Code working on this project.** Read this file in full at the start of every session. Then read `ROADMAP.md` to pick up the next task.

## What this project is

Desktop application for **photorealistic interior decoration**. The user uploads a photo of a room and one or more photos of furniture / frames / wallpaper / decorative elements, and the app composes them into the scene with realistic perspective, scale, lighting, and shadows. Target users: homeowners, real-estate stagers, interior design enthusiasts.

## Stack

- **Frontend desktop**: Tauri 2 + React 18 + TypeScript + Vite + Tailwind
- **Backend orchestration**: Python 3.12 + FastAPI, launched by Tauri as a sidecar process
- **ML inference**: Cloud only (fal.ai) — Flux Fill + Redux for reference-conditioned inpainting, Depth Anything V2 for depth, SAM 2 for segmentation
- **Package manager**: `pnpm` (frontend), `uv` (Python), `cargo` (Tauri)
- **Target host**: macOS first (Apple Silicon), MacBook Pro M1, 16 GB RAM. Windows/Linux later.

## Why these choices (do not re-debate)

- **Cloud-only ML in V1**: 16 GB unified RAM on M1 is too tight to run Flux locally without degrading the rest of the experience. Cloud removes packaging complexity and gives consistent quality.
- **Python sidecar over pure Rust ML**: ML libraries are far more mature in Python; the sidecar pattern is well supported in Tauri 2.
- **Tauri over Electron**: smaller binary, native performance, lower memory footprint.

See `docs/adr/` for fuller rationale on each decision.

## Repository layout

```
.
├── apps/
│   ├── desktop/        # Tauri 2 + React + TS
│   │   ├── src/        # React UI
│   │   └── src-tauri/  # Rust (Tauri commands, sidecar mgmt)
│   └── api/            # Python FastAPI sidecar
├── packages/
│   └── shared-types/   # TS types generated from Python pydantic models
├── docs/
│   ├── adr/            # Architecture Decision Records
│   ├── ARCHITECTURE.md
│   ├── ML_PIPELINE.md
│   └── IPC.md
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── .claude/
│   ├── agents/         # subagents
│   ├── commands/       # slash commands
│   └── settings.json
├── CLAUDE.md           # this file
├── ROADMAP.md          # task list — source of truth
└── README.md
```

## Conventions

### Branches
- `feat/<short-kebab>` — new feature
- `fix/<short-kebab>` — bug fix
- `chore/<short-kebab>` — tooling, deps, infra
- `docs/<short-kebab>` — documentation only
- `refactor/<short-kebab>` — no behavior change

### Commits — Conventional Commits, enforced by commitlint
Format: `<type>(<scope>): <subject>`

- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`
- Scopes: `desktop`, `api`, `ipc`, `ml`, `ci`, `docs`, `deps`, or task ID like `0.3`
- Breaking changes: `feat(api)!: ...` or footer `BREAKING CHANGE: ...`

Examples:
- `feat(desktop): add room photo upload screen`
- `fix(api): handle fal.ai timeout gracefully`
- `chore(deps): bump tauri to 2.1`

### Pull Requests
- One ROADMAP task = one branch = one PR. No bundling.
- PR title: `<type>(<scope>): <subject> [task X.Y]`
- PR description must reference the task ID and check the acceptance criteria.
- All CI checks green + 1 review (self-review allowed for solo dev) before merge.
- Squash-merge to keep `main` linear.

### Tests
- Every feature ships with tests in the same PR.
- Coverage gate: 70% lines, configured in CI.
- Frontend: Vitest (unit) + Playwright (Tauri e2e where relevant).
- Backend: pytest + pytest-asyncio + httpx for FastAPI client.
- ML calls in tests are mocked unless explicitly marked `@pytest.mark.live` (requires `FAL_KEY`).

## Quality gates (run before every commit)

`pre-commit` enforces these locally. Don't bypass with `--no-verify`.

```
pnpm lint
pnpm typecheck
pnpm test
cd apps/api && uv run ruff check . && uv run ruff format --check .
cd apps/api && uv run pytest
cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy -- -D warnings
```

## Picking up a task

1. Read the next unchecked task in `ROADMAP.md`.
2. Run `/start-task <id>` (or manually: create branch, read referenced docs).
3. Implement. Read related docs in `docs/` first when relevant.
4. Add/update tests in the same PR.
5. Update `ROADMAP.md`: mark the task `[x]`.
6. Run `/wrap-pr` (or manually: run all quality gates, push, open PR with the task ID in title).
7. After merge, delete the branch.

## Hard rules — do not violate

- **No direct push to `main`**. Branch protection enforces it; don't try to circumvent.
- **No secrets in git**. Use `.env.local` (gitignored), commit `.env.example` only.
- **No bypassing pre-commit** (`--no-verify` is forbidden).
- **No new ML dependency in the local runtime** without an ADR.
- **No silent dependency upgrade** of major versions; open a separate `chore(deps)` PR.
- **No new architectural pattern** without writing an ADR first.

## When you are unsure

- About a design decision: write a draft ADR in `docs/adr/`, ask the user.
- About a task being too large: split it in ROADMAP, propose the split in a comment, wait for confirmation.
- About a tool/library choice: prefer the one already in the stack; only introduce new ones with justification.

## Useful references

- ML pipeline details: `docs/ML_PIPELINE.md`
- Tauri ↔ Python IPC contract: `docs/IPC.md`
- Architecture overview: `docs/ARCHITECTURE.md`
- ADRs: `docs/adr/`

## Subagents available (in `.claude/agents/`)

Delegate to these for focused work — they have isolated context and are cheaper to run.

- **`architecture-keeper`** — verifies hexagonal boundaries in `apps/api/`, isolation of fal SDK, IPC contract stability, ADR discipline. Invoke on every backend PR.
- **`security-auditor`** — full security review: Tauri capabilities, sidecar auth, secret handling, supply chain, SSRF, etc. Invoke on every PR touching auth/IPC/network/deps, and before every release.
- **`design-reviewer`** — UI/UX/a11y/macOS HIG review. Invoke on every PR touching `apps/desktop/src/**`.
- **`caveman-reviewer`** — ultra-terse one-line review. Use as fast second-pass, or when reviewing a small change where a full reviewer is overkill.

The `wrap-pr` slash command auto-invokes the relevant reviewers in parallel.

## MCP servers (configured in `.claude/settings.json`)

- **`context7`** — fetches version-specific library docs on demand. **Use it whenever you touch a library you haven't worked with this session** (Tauri 2 APIs, FastAPI, fal-client, Vite plugins, Tauri plugins, etc.). Trigger by mentioning "use context7" or naming the library explicitly. This is your defense against hallucinated APIs.
- **`github`** — issue/PR/release management. Requires `GITHUB_PERSONAL_ACCESS_TOKEN` in the user's shell.
- **`sequential-thinking`** — for tasks that need explicit multi-step reasoning before any code change. Use it on Phase 2-3 ML pipeline tasks.

## Slash commands (in `.claude/commands/`)

- **`/start-task <id>`** — read task from ROADMAP, validate prerequisites, create branch, surface relevant docs, summarize back to user before writing any code.
- **`/wrap-pr [id]`** — run all local gates, invoke review subagents, update ROADMAP, push, open PR with structured description.
- **`/sync`** — rebase current branch on `origin/main`, report conflicts without auto-resolving.

## Token-economy guidelines for you (Claude Code)

- Read `ROADMAP.md` only when picking up a task, not on every turn.
- Delegate to subagents whenever a task is bounded (review, exploration, test writing). Their isolated context saves the main thread.
- Use Context7 instead of guessing an API. One Context7 lookup costs less than a wrong implementation followed by a fix.
- Never re-explain decisions documented in `docs/adr/`. Reference the ADR by number.
- Prefer the `caveman-reviewer` over the full reviewers when the diff is < 50 lines.
