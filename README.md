# Interior Vision

Upload a photo of your room and one or more furniture or decor images — Interior Vision composites them into a photorealistic scene with accurate perspective, scale, lighting, and shadows. Built for homeowners, real-estate stagers, and interior design enthusiasts who want to visualise changes before buying.

![CI](https://github.com/GuillaumeElhadi/desired-interior/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/GuillaumeElhadi/desired-interior)

## Status

🚧 Early development — Phase 0 (foundation) in progress.

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
# Prerequisites: Node 20+, pnpm, Python 3.12+, uv, Rust + cargo

git clone https://github.com/GuillaumeElhadi/desired-interior.git
cd desired-interior
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

See [`CLAUDE.md`](CLAUDE.md) for full project conventions and task workflow.

## License

[MIT](LICENSE)
