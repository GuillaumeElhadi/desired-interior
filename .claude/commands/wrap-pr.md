---
description: Finalize the current branch — run all gates, invoke reviewers, mark ROADMAP, push, open PR.
argument-hint: [task-id] (optional, inferred from branch name if omitted)
---

You are finalizing the current branch and opening its PR.

Steps:

1. Determine task ID:
   - If `$ARGUMENTS` is provided, use it.
   - Else parse it from the latest commit message (look for `[task X.Y]`) or the branch name.
   - If still unknown, ask me.

2. Run the full local gate (do not proceed past a failure — fix and re-run, or hand control back to me):
   - `pnpm install --frozen-lockfile`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test --run`
   - `pnpm codegen` (verify no diff after run)
   - `cd apps/api && uv sync && uv run ruff check . && uv run ruff format --check . && uv run pytest`
   - `cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test`

3. Invoke review subagents in parallel:
   - `architecture-keeper` on the diff
   - `security-auditor` on the diff
   - `design-reviewer` if the diff touches `apps/desktop/src/**`
   - Compile findings. If any 🔴, STOP and surface them. Do not push.

4. Update `ROADMAP.md`: change `- [ ]` to `- [x]` on the task and on each acceptance-criterion checkbox you've satisfied. Commit this as `chore(roadmap): mark task X.Y done`.

5. `git push -u origin <branch>` (the deny rule blocks pushing to main directly).

6. Open the PR with `gh pr create`:
   - Title: `<type>(<scope>): <subject> [task X.Y]`
   - Body template:

     ```
     ## Linked task
     ROADMAP.md → X.Y

     ## Summary
     <one-paragraph>

     ## Changes
     - bullet list

     ## Tests
     - what you added / what you ran

     ## Acceptance criteria
     - [x] each criterion from ROADMAP, copied verbatim

     ## Reviews
     <copy the architecture/security/design review summaries here, one section per agent>
     ```

7. Report to me: PR URL, summary of CI status (run `gh pr checks <number>` once after a 30s wait).

**Do not merge.** I do that.
