# ADR 0001 — Branch Protection on `main`

**Date:** 2026-05-03
**Status:** Accepted

---

## Context

`main` is the only long-lived branch and the single source of truth for releases. Without protection, any contributor (or Claude Code itself) could push directly, bypass CI, rewrite history, or delete the branch. Even as a solo-developer project, enforcing a PR-based workflow provides an audit trail, a natural code-review checkpoint before any change lands, and a safety net against accidental force-pushes.

---

## Decision

Branch protection is configured on `main` via the GitHub REST API with the following settings:

| Setting | Value | Rationale |
|---|---|---|
| Require pull request before merging | ✅ | No direct pushes; every change goes through a PR |
| Required approving reviews | 0 | Solo dev — GitHub does not support self-approval; PRs still require the PR workflow |
| Dismiss stale reviews on push | ✅ | A new commit invalidates a prior approval |
| Require code owner review | ❌ | No CODEOWNERS file yet; re-evaluate when team grows |
| Require last-push approval | ❌ | Redundant with dismiss-stale for solo dev |
| Required status checks | None (yet) | CI jobs (`lint`, `typecheck`, `test-*`, `coverage-gate`, `build-check`) are added in task 0.4; they will be added to required checks at that point |
| Require branches to be up to date | ❌ | Added alongside status checks in task 0.4 |
| Require conversation resolution | ✅ | All review comments must be resolved before merge |
| Require linear history | ✅ | Squash-merge only; keeps `main` a clean single-parent chain |
| Allow force pushes | ❌ | Blocked unconditionally |
| Allow deletions | ❌ | Blocked unconditionally |
| Enforce for administrators | ✅ | The repo owner is also subject to these rules |

### Self-review workaround for solo development

GitHub does not allow a PR author to approve their own PR. Required reviews are set to **0** rather than 1 to allow the solo developer to merge their own PRs through the normal PR flow without a separate approving account. The trade-off is intentional: the audit trail and CI gate (once online) provide sufficient safety; a self-review counter would add friction with no real protection on a solo project.

When the project becomes a team effort, increment `required_approving_review_count` to 1 (or higher) and add the team to CODEOWNERS.

### Status checks (deferred to task 0.4)

The following jobs will be added as required status checks once the CI workflow is wired up in task 0.4:

- `lint`
- `typecheck`
- `test-frontend`
- `test-backend`
- `coverage-gate`
- `build-check`

The API call to add them is:

```bash
gh api repos/GuillaumeElhadi/desired-interior/branches/main/protection/required_status_checks/contexts \
  --method POST \
  --raw-field 'contexts[]=lint' \
  --raw-field 'contexts[]=typecheck' \
  # ... etc.
```

---

## Consequences

### Positive
- `git push origin main` is rejected for all actors including the repo owner.
- Force-pushes and branch deletions are blocked.
- History stays linear (squash-merge enforced), making `git log` and `git bisect` reliable.
- Every change has a PR URL, a commit SHA, and a conversation thread.

### Negative / Trade-offs
- A solo developer cannot self-approve PRs; merging requires using the GitHub UI "Merge pull request" button (or `gh pr merge`) without an approval.
- Status checks are not yet enforced — a PR can be merged before CI exists. This gap closes in task 0.4.
- Making the repo public (required for branch protection on GitHub Free) means source code is publicly visible from this point forward.
