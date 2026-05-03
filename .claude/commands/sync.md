---
description: Rebase current branch on top of latest main. Reports conflicts without trying to resolve them silently.
---

Bring the current branch up to date with `origin/main`.

Steps:

1. Refuse if I'm currently on `main`. Ask me to checkout the feature branch first.
2. `git fetch origin`
3. Stash if working tree dirty: `git stash push -m "auto-sync $(date +%s)"` and remember to pop later.
4. `git rebase origin/main`
5. If conflicts:
   - Run `git status` and list conflicted files
   - Stop. Report which files are conflicted and ask how to proceed. Do not attempt automatic resolution unless I say so.
6. If clean:
   - Pop the stash if any
   - Confirm: "rebased on origin/main at <short SHA>, N commits ahead"
   - If the branch was previously pushed, remind me to `git push --force-with-lease` (do not run it for me)
