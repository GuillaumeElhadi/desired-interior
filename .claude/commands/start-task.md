---
description: Start a ROADMAP task — read it, validate prerequisites, create the branch, surface the relevant docs.
argument-hint: <task-id> (e.g. 1.3)
---

You are starting task **$ARGUMENTS** from `ROADMAP.md`.

Steps, in order:

1. Read `ROADMAP.md`. Find the section matching task ID `$ARGUMENTS` (format `### X.Y title`).
2. **Verify prerequisites**: every earlier task in the same phase must already be checked `[x]`. If any is unchecked, STOP and report which task is blocking. Do not proceed.
3. Read `CLAUDE.md` if it's not already in context this session.
4. Identify the branch name from the task block (line `- [ ] Branch: ...`). If absent, derive one: `<type>/<short-kebab-from-title>`.
5. Run:
   - `git fetch origin`
   - `git checkout main && git pull --rebase origin main`
   - `git checkout -b <branch-name>` (fail loudly if the branch already exists)
6. Read every doc the task references (e.g. `docs/IPC.md`, `docs/ML_PIPELINE.md`, ADRs).
7. If the task involves a library you haven't touched in this session (Tauri 2, FastAPI, fal-client, etc.), call Context7: `use context7 to fetch docs for <library>`.
8. Summarize back to me:
   - Task title and goal
   - Acceptance criteria (verbatim)
   - Branch name
   - Files you expect to touch
   - Any risk or ambiguity you spotted

**Do not start writing code yet.** Wait for my "go" after the summary. This avoids wasted turns on misunderstood scope.
