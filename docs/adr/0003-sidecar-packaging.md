# ADR 0003 — Python Sidecar Packaging

**Date:** 2026-05-05
**Status:** Accepted

---

## Context

The Python FastAPI sidecar must be bundled with the Tauri app so that end users do not need to install Python, uv, or any system dependencies. Tauri 2's `externalBin` mechanism expects a self-contained executable at a known path. Three approaches were considered.

---

## Options considered

### Option A: PyInstaller `--onefile`

PyInstaller freezes the Python interpreter, all imported modules, and application code into a single Mach-O/ELF executable. On launch it decompresses the bundle into a temporary directory and runs from there.

**Pros:**

- Single file → trivial `externalBin` mapping (`"binaries/interior-vision-api"`)
- Tauri's target-triple naming convention (`interior-vision-api-aarch64-apple-darwin`) satisfied naturally
- No directory-traversal complexity for Tauri's bundler

**Cons:**

- First cold-start decompresses ~20–60 MB of Python stdlib and packages (~0.5–2 s on Apple Silicon)
- Subsequent launches reuse the cached temp directory (keyed by hash), so warm starts are fast

### Option B: PyInstaller `--onedir`

PyInstaller produces a directory containing the executable and all supporting files side-by-side.

**Pros:**

- No decompression on launch — fastest cold start

**Cons:**

- Tauri `externalBin` expects a single file path, not a directory. The workaround — copying the whole directory into `Resources/` and symlinking the binary into `MacOS/` — is non-standard, fragile across Tauri versions, and not documented.
- Build script complexity grows substantially with no meaningful benefit for this use case.

### Option C: `uv run` at runtime (no pre-build)

Instead of bundling, Rust spawns `uv run uvicorn app.main:app` against the source tree. The user must have `uv` installed and the source tree present.

**Pros:**

- No build step during development (already the dev workflow)
- Always runs the latest source without a rebuild

**Cons:**

- Breaks the distribution model: end users of the distributed `.app` bundle do not have Python or uv installed
- Cannot work inside a signed `.app` bundle shipped to users without source
- Only viable during development, not for production or CI

---

## Decision

Use **PyInstaller `--onefile`** (Option A).

The cold-start penalty (~1–2 s on Apple Silicon M1 with a warm filesystem) is acceptable for an interior design app where the sidecar starts once and runs for the whole session. The simplicity of a single file for `externalBin` and alignment with Tauri's documented sidecar conventions outweigh the startup cost.

The binary is built by `make build-sidecar` and gitignored. CI rebuilds it in the `build-check` job before `pnpm tauri build --debug`.

---

## Consequences

### Positive

- Single-file distribution: `tauri.conf.json` `externalBin` and capability config are straightforward.
- No runtime Python dependency required on the user's machine.
- `make build-sidecar` is a one-command developer setup step.
- Binary naming (`interior-vision-api-<triple>`) is handled automatically by Tauri at bundle time.

### Negative / Trade-offs

- First cold start after a fresh install decompresses the bundle. Can be mitigated later by switching to `--onedir` with a custom Tauri bundle hook, if startup latency becomes a measured UX problem.
- `pyinstaller` is added to the dev dependency group in `pyproject.toml`; it expands `uv sync` time on first install.
- The binary is not committed to git. Every developer must run `make build-sidecar` after cloning. This is documented in `README.md` and enforced in CI (`build-check` job runs `make build-sidecar` before `pnpm tauri build --debug`).

### Future consideration

If cold-start latency is measured as user-perceptible pain (observable in task 1.5 observability work), revisit `--onedir` with a Tauri `beforeBundleCommand` hook. Document the migration in a new ADR at that time.

---

## Summary table

| Option      | Cold start              | Bundle complexity               | Distribution              | Decision    |
| ----------- | ----------------------- | ------------------------------- | ------------------------- | ----------- |
| `--onefile` | ~1–2 s (decompression)  | Minimal                         | Works in `.app`           | ✅ Chosen   |
| `--onedir`  | Fast (no decompression) | High (non-standard Tauri hooks) | Possible with workarounds | ❌ Rejected |
| `uv run`    | Instant (dev only)      | None                            | Breaks for end users      | ❌ Rejected |
