# Interior Vision

Upload a photo of your room and one or more furniture or decor images — Interior Vision composites them into a photorealistic scene with accurate perspective, scale, lighting, and shadows. Built for homeowners, real-estate stagers, and interior design enthusiasts who want to visualise changes before buying.

![CI](https://github.com/GuillaumeElhadi/desired-interior/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/GuillaumeElhadi/desired-interior)

## Status

🚧 Early development — Phase 1 (skeleton) in progress.

## Stack

| Layer                 | Technology                                           |
| --------------------- | ---------------------------------------------------- |
| Desktop shell         | Tauri 2 + React 18 + TypeScript + Vite               |
| Styling               | Tailwind CSS                                         |
| Backend orchestration | Python 3.12 + FastAPI (Tauri sidecar)                |
| ML inference          | fal.ai — Flux Fill + Redux, Depth Anything V2, SAM 2 |
| Package managers      | pnpm · uv · cargo                                    |
| Target platform       | macOS (Apple Silicon) — Windows/Linux later          |

## Development setup

```bash
# Prerequisites: Node 22 (see .nvmrc), pnpm, Python 3.12+, uv, Rust + cargo

git clone https://github.com/GuillaumeElhadi/desired-interior.git
cd desired-interior
nvm use           # switches to Node 22 (from .nvmrc)
make setup        # installs pnpm deps + pre-commit hooks
```

`make setup` runs `pnpm install` then `pre-commit install` (for the `pre-commit` stage) and
`pre-commit install --hook-type commit-msg` (for the `commit-msg` stage). Run it once after
every fresh clone or when `.pre-commit-config.yaml` changes.

### Pre-commit hooks

| Hook                                               | What it checks                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `trailing-whitespace`, `end-of-file-fixer`         | Basic file hygiene                                                                    |
| `check-yaml`, `check-json`, `check-merge-conflict` | Syntax validity                                                                       |
| `prettier`                                         | Formatting — TS/TSX/JS/JSON/MD/YAML                                                   |
| `eslint`                                           | Linting — TypeScript/JavaScript in `apps/desktop/src/`                                |
| `ruff`                                             | Python lint + format (skipped until `apps/api/` exists)                               |
| `rustfmt`                                          | Rust formatting (skipped until `apps/desktop/src-tauri/` exists)                      |
| `gitleaks`                                         | Secret detection — blocks commits containing API keys, tokens, etc.                   |
| `commitlint`                                       | Enforces [Conventional Commits](https://www.conventionalcommits.org/) on `commit-msg` |

### Building the Python sidecar binary

Run once after cloning, and again after any Python code change:

```bash
make build-sidecar   # ~30 s first time; faster on repeat (PyInstaller cache)
```

The binary is gitignored — it must exist at `apps/desktop/src-tauri/binaries/` before running `pnpm tauri dev`.

### Running the Python API locally

```bash
cd apps/api
uv sync                                  # install deps into .venv
uv run uvicorn app.main:app --reload     # starts on http://localhost:8000
# test: curl http://localhost:8000/health

uv run pytest                            # tests + coverage report
uv run ruff check .                      # lint
```

### Running the desktop app locally

```bash
nvm use                          # Node 22 required (Vite 8 / Vitest 4)
cd apps/desktop

# Full Tauri app (native window + frontend hot-reload)
pnpm tauri dev

# Frontend only (browser, no native window)
pnpm dev

# Tests
pnpm test          # watch mode
pnpm test:run      # single run
pnpm coverage      # single run with coverage report

# Type-check + lint
pnpm typecheck
pnpm lint
```

> **First run**: `pnpm tauri dev` compiles the Rust crate on first launch (~1 min on Apple Silicon).
> Subsequent runs use the incremental build cache and start in a few seconds.

See [`CLAUDE.md`](CLAUDE.md) for full project conventions and task workflow.

## Security

See [`SECURITY.md`](SECURITY.md) for the vulnerability disclosure policy.

## License

[MIT](LICENSE)
