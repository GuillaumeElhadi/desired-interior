# Interior Vision

Upload a photo of your room and one or more furniture or decor images — Interior Vision composites them into a photorealistic scene with accurate perspective, scale, lighting, and shadows. Built for homeowners, real-estate stagers, and interior design enthusiasts who want to visualise changes before buying.

![CI](https://github.com/GuillaumeElhadi/desired-interior/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/GuillaumeElhadi/desired-interior)

## Status

🚧 Early development — Phase 0 (foundation) in progress.

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 + React 18 + TypeScript + Vite |
| Styling | Tailwind CSS |
| Backend orchestration | Python 3.12 + FastAPI (Tauri sidecar) |
| ML inference | fal.ai — Flux Fill + Redux, Depth Anything V2, SAM 2 |
| Package managers | pnpm · uv · cargo |
| Target platform | macOS (Apple Silicon) — Windows/Linux later |

## Development setup

```bash
# Prerequisites: Node 20+, pnpm, Python 3.12+, uv, Rust + cargo

git clone https://github.com/GuillaumeElhadi/desired-interior.git
cd desired-interior
make setup        # installs pre-commit hooks + dependencies
```

See [`CLAUDE.md`](CLAUDE.md) for full project conventions and task workflow.

## License

[MIT](LICENSE)
