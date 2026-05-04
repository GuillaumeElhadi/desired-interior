# ADR 0004 — Frontend Toolchain Versions

**Date:** 2026-05-04
**Status:** Accepted

---

## Context

Task 1.1 bootstrapped `apps/desktop/` and required several concrete toolchain choices. These decisions were made at implementation time without a prior ADR, which violated the "no new architectural pattern without writing an ADR first" rule. This document retroactively records those decisions and their rationale.

---

## Decisions

### Node.js 22 (bumped from "Node 20+" in CLAUDE.md)

**Decision:** Require Node 22, pinned via `.nvmrc`.

**Rationale:** Vite 8 and Vitest 4 use [rolldown](https://github.com/rolldown/rolldown) (a Rust-based JS bundler) as their underlying build engine. Rolldown's Node.js bindings call `util.styleText`, which was added in Node 20.12.0 but is fully stable only from Node 22. Using an older Node version (18) caused a `SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'` crash at startup. Node 22 is the current LTS and the safest target for long-term support.

**Consequences:** All developers must use Node 22. The `.nvmrc` file at the repo root enforces this for nvm users. CI was updated to `NODE_VERSION: "22"`.

---

### Vite 8 + Vitest 4 (latest majors)

**Decision:** Use Vite 8.x and Vitest 4.x.

**Rationale:** These are the current stable major versions as of project start (May 2026). Starting a new project on the latest stable reduces future migration work. Both adopt rolldown for significantly faster builds. The Node 22 requirement is the only trade-off (see above).

**Consequences:** Node 22 required (see above). Vitest 4 coverage API unchanged from v3 — `@vitest/coverage-v8` with `json-summary` reporter works identically.

---

### React 18 (held at 18, not upgraded to 19)

**Decision:** Use React 18.3.x despite React 19 being the current stable.

**Rationale:** CLAUDE.md explicitly specifies "React 18" in the stack definition. React 19 introduces breaking changes in concurrent rendering APIs and ref handling that could complicate the Tauri integration. For a greenfield project, starting on the declared stack version and upgrading deliberately is safer than silently adopting a new major. This decision should be revisited before v1.0.

**Consequences:** React 19 features (use hook, server components, improved transitions) are not available. Upgrade path is straightforward — no React 18 deprecated APIs are used in the scaffold.

---

### Tailwind CSS v4 (zero-config)

**Decision:** Use Tailwind v4 via the `@tailwindcss/vite` Vite plugin.

**Rationale:** Tailwind v4 was released in early 2025 and is the current stable version. Its key changes from v3: no `tailwind.config.js` required for basic usage, CSS-first configuration via `@import "tailwindcss"`, and tighter Vite integration via a first-party plugin that eliminates PostCSS as a separate step. For a new project this is strictly simpler to maintain than v3.

**Consequences:** No `tailwind.config.js` in the repo — theme customisation will be done in CSS using `@theme {}` directives (v4 syntax) rather than JavaScript config. Documentation and community examples targeting Tailwind v3 will not apply directly.

---

## Summary table

| Choice   | Value  | Alternative considered                              |
| -------- | ------ | --------------------------------------------------- |
| Node.js  | 22 LTS | 20 LTS (rejected: `styleText` instability)          |
| Vite     | 8.x    | 6.x (rejected: would become stale immediately)      |
| Vitest   | 4.x    | 3.x (rejected: same reason)                         |
| React    | 18.3   | 19.x (deferred: CLAUDE.md spec + integration risk)  |
| Tailwind | v4     | v3 (rejected: v4 is current stable, simpler config) |
