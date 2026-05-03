# ADR 0002 — Release Strategy

**Date:** 2026-05-03
**Status:** Accepted

---

## Context

The project needs a repeatable, low-ceremony release process that:

- Automatically generates a `CHANGELOG.md` from Conventional Commit history
- Tags releases in Git (`v1.2.3`)
- Bumps version numbers in all the places that need them (`package.json`, `pyproject.toml`, `tauri.conf.json`)
- Does not require the developer to manually edit files or run scripts on release day
- Works from the first `feat:` or `fix:` commit onward with no additional setup

---

## Decision

Use **[release-please](https://github.com/googleapis/release-please)** in manifest mode, driven by a GitHub Actions workflow that triggers on every push to `main`.

### How it works

1. A developer merges a PR to `main` with conventional commits (`feat:`, `fix:`, `chore:`, etc.).
2. The `release-please` GitHub Actions job runs and inspects the unreleased commits.
3. If there are any `feat:` or `fix:` commits since the last release tag, release-please opens (or updates) a **release PR** that contains:
   - A `CHANGELOG.md` update listing all changes since the last tag
   - Version bumps in all configured `extra-files`
   - A PR title of the form `chore(main): release X.Y.Z`
4. The developer reviews and merges the release PR.
5. release-please tags the merge commit `vX.Y.Z` and creates a GitHub Release.
6. Downstream jobs (code signing, notarization, DMG packaging — tasks 5.1–5.3) watch for the `release_created` output and run automatically.

`chore:`, `docs:`, `refactor:`, `test:`, `ci:` commits do **not** trigger a release PR — they accumulate silently.

### Configuration choices

| Setting                          | Value          | Reason                                                          |
| -------------------------------- | -------------- | --------------------------------------------------------------- |
| `release-type`                   | `simple`       | Multi-language monorepo; no single language owns versioning     |
| `tag-name-pattern`               | `v${version}`  | Conventional; compatible with Tauri updater and GitHub Releases |
| `changelog-path`                 | `CHANGELOG.md` | Standard root-level file                                        |
| `bump-minor-pre-major`           | `true`         | `feat:` bumps minor (0.x → 0.x+1) before v1.0 instead of major  |
| `bump-patch-for-minor-pre-major` | `true`         | `fix:` bumps patch before v1.0                                  |
| Initial version                  | `0.0.0`        | First real feature release will be `0.1.0`                      |

### Version files kept in sync

| File                                                 | How updated                    |
| ---------------------------------------------------- | ------------------------------ |
| `apps/desktop/package.json` → `version`              | `extra-files` (plain JSON)     |
| `apps/api/pyproject.toml` → `project.version`        | `extra-files` (TOML, JSONPath) |
| `apps/desktop/src-tauri/tauri.conf.json` → `version` | `extra-files` (JSON, JSONPath) |

These files don't exist yet; release-please skips missing files and will start bumping them from the task (1.1–1.3) in which they are created.

### Authentication

The workflow uses a fine-grained PAT stored as `RELEASE_PLEASE_TOKEN` (repository secret). It requires `contents:write` and `pull-requests:write` on this repository. The default `GITHUB_TOKEN` is intentionally not used because GitHub blocks it from triggering subsequent workflow runs — using a PAT allows the release tag push to trigger the signing/distribution CI jobs added in Phase 5.

---

## Consequences

### Positive

- Zero manual steps to produce a well-formed release with changelog, tag, and GitHub Release.
- Consistent versioning across all three sub-projects (desktop, API, Tauri).
- release-please PRs are reviewable before merging, giving a final sanity-check gate.
- `chore:`-only histories (like Phase 0) never produce release noise.

### Negative / Trade-offs

- Requires a long-lived fine-grained PAT (`RELEASE_PLEASE_TOKEN`). This token must be rotated periodically and re-stored in GitHub Secrets.
- `release-type: simple` does not understand semantic meaning of changes inside each sub-package; all bumps are at the monorepo root level. Per-package versioning can be adopted later by switching to manifest mode with multiple packages.
- Until `apps/desktop/package.json`, `apps/api/pyproject.toml`, and `apps/desktop/src-tauri/tauri.conf.json` are created, version bumps in those files are silently skipped. This is acceptable — the files will be created in tasks 1.1–1.3.
