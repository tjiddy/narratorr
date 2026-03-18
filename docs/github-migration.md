# GitHub Migration Playbook

Steps to migrate narratorr from Gitea (`git.tjiddy.com/todd/narratorr`) to GitHub (`github.com/tjiddy/narratorr`) for the v1.0 public release. Validated against the narratorr-poc dry run.

## Pre-Migration

### 1. Create GitHub Repository
- Create `tjiddy/narratorr` on GitHub (public, no template, no README)
- Add repository secrets under **Settings > Secrets and variables > Actions**:
  - `DOCKERHUB_USERNAME` — Docker Hub username
  - `DOCKERHUB_TOKEN` — Docker Hub access token

### 2. Create Docker Hub Repository
- Create `narratorr/narratorr` on Docker Hub (or confirm it exists from POC testing)
- Ensure the token has push access

## Migration

### 3. Clone from Gitea (preserves full history + file modes)
```bash
git clone https://git.tjiddy.com/todd/narratorr.git narratorr-github
cd narratorr-github
```

> **Do NOT use `git archive` or copy files.** Cloning preserves executable bits, commit history, and git metadata. We learned this the hard way — `git archive | tar` strips file permissions on Windows.

### 4. Swap Remote
```bash
git remote set-url origin https://github.com/tjiddy/narratorr.git
```

### 5. Find All Gitea/GHCR References
```bash
grep -rn "git.tjiddy.com\|ghcr.io/todd\|REGISTRY_USER\|REGISTRY_PASSWORD\|todd/narratorr" \
  --include="*.ts" --include="*.tsx" --include="*.yaml" --include="*.yml" \
  --include="*.json" --include="*.md" \
  | grep -v node_modules | grep -v pnpm-lock | grep -v ".claude/cl/"
```

### 6. Apply Reference Changes

| Find | Replace | Files |
|------|---------|-------|
| `https://git.tjiddy.com/todd/narratorr` | `https://github.com/tjiddy/narratorr` | CLAUDE.md, CONTRIBUTING.md, README.md |
| `git.tjiddy.com/todd/narratorr` | `github.com/tjiddy/narratorr` | CLAUDE.md, CONTRIBUTING.md, README.md |
| `ghcr.io/todd/narratorr` | `narratorr/narratorr` | README.md, docker-compose.yml |
| `REGISTRY_USER` / `REGISTRY_PASSWORD` | `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | README.md |
| `Gitea repository` / `Gitea Actions` | `GitHub repository` / `GitHub Actions` | README.md |
| `https://api.github.com/repos/todd/narratorr/` | `https://api.github.com/repos/tjiddy/narratorr/` | src/server/jobs/version-check.ts |
| Gitea dev env vars section | GitHub token section | README.md |

### 7. Convert CI Workflows

**Delete:** `.gitea/workflows/` directory

**Create:** `.github/workflows/ci.yml` — PR + push quality gates (lint, typecheck, test, build, health smoke test)

**Create:** `.github/workflows/docker.yml` — Tag-triggered Docker build pipeline:
- Quality gates
- Docker Hub login (DOCKERHUB_USERNAME / DOCKERHUB_TOKEN)
- Multi-arch build (amd64 + arm64)
- Image size reporting
- Multi-arch manifest verification
- Container smoke test (health endpoint + Node version check)

> Use `env.IMAGE_NAME: narratorr/narratorr` at workflow level so tags reference `${{ env.IMAGE_NAME }}` instead of hardcoded registry paths.

### 8. Update Docker Workflow Tests

**File:** `docker/docker-workflow.test.ts`

| Change | Why |
|--------|-----|
| `.gitea/workflows/docker.yaml` → `.github/workflows/docker.yml` | New workflow location |
| `ghcr.io/todd/narratorr` → `narratorr/narratorr` or `IMAGE_NAME` env var pattern | Docker Hub registry |
| `REGISTRY_USER` / `REGISTRY_PASSWORD` → `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | Secret names |
| Tag assertions may need updating if workflow uses `${{ env.IMAGE_NAME }}` interpolation | Tags are templated, not literal |

### 9. Fix Executable Bits (Windows only)

If migrating from a Windows machine, verify executable permissions:

```bash
git ls-files -s docker/root/etc/s6-overlay/s6-rc.d/svc-narratorr/run
```

If the output shows `100644` instead of `100755`:

```bash
git update-index --chmod=+x docker/root/etc/s6-overlay/s6-rc.d/svc-narratorr/run
```

> Check ALL shell scripts: `git ls-files -s | grep '\.sh$\|/run$' | grep -v 100755`

### 10. Verify

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run docker/docker-workflow.test.ts
pnpm test
pnpm build
```

### 11. Push

```bash
git add -A
git commit -m "Migrate to GitHub + Docker Hub for v1.0 release"
git push -u origin main
```

### 12. Tag v1.0

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the full Docker pipeline: quality gates → build → push → verify → smoke test.

## Post-Migration

### 13. Verify CI
- Check **Actions** tab: both CI and Docker workflows should run
- Verify `narratorr/narratorr:1.0.0` and `narratorr/narratorr:latest` exist on Docker Hub
- Pull and run: `docker pull narratorr/narratorr:1.0.0`

### 14. Update External References
- Documentation site (`narratorr-docs`) — update any Gitea links
- Docker Hub description — add repo link and getting started
- Any bookmarks, scripts, or tools pointing to Gitea

### 15. Archive Gitea Repo
- Set Gitea repo to read-only/archived
- Add notice pointing to GitHub

## Skill & Script Migration (gitea.ts → gh CLI)

### Prerequisites
- Install `gh`: `winget install GitHub.cli`
- Authenticate: `gh auth login`
- `gh` reads auth from its own config, not `.env`

### Command Mapping

Every `node scripts/gitea.ts` call and its `gh` equivalent:

| gitea.ts command | gh equivalent |
|---|---|
| `issue <id>` | `gh issue view <id>` |
| `issue-create <title> --body-file <path> <labels> <milestone>` | `gh issue create --title "<title>" --body-file <path> --label "l1,l2" --milestone "<m>"` |
| `issue-update <id> labels <labels>` | `gh issue edit <id> --remove-label "<old>" --add-label "<new>"` |
| `issue-update <id> body --body-file <path>` | `gh issue edit <id> --body-file <path>` |
| `issue-update <id> state closed` | `gh issue close <id>` |
| `issue-comments <id>` | `gh issue view <id> --comments --json comments --jq '.comments[] \| "--- comment \(.author.login) \(.createdAt) ---\n\(.body)"'` |
| `issue-comment <id> --body-file <path>` | `gh issue comment <id> --body-file <path>` |
| `issues [all]` | `gh issue list --state open` (or `--state all`) |
| `search <query>` | `gh issue list --search "<query>"` |
| `prs` | `gh pr list` |
| `pr <number>` | `gh pr view <number>` |
| `pr-create <title> --body-file <path> <head> [base]` | `gh pr create --title "<title>" --body-file <path> --head <head> --base <base>` |
| `pr-comment <number> --body-file <path>` | `gh pr comment <number> --body-file <path>` |
| `pr-comments <number>` | `gh pr view <number> --comments --json comments --jq '.comments[] \| "--- comment \(.author.login) \(.createdAt) ---\n\(.body)"'` |
| `pr-merge <number> [squash]` | `gh pr merge <number> --squash --delete-branch` |
| `pr-update-labels <number> <labels>` | `gh pr edit <number> --remove-label "<old>" --add-label "<new>"` |
| `commit-status <ref>` | `gh api repos/{owner}/{repo}/commits/<ref>/status --jq '.state'` |
| `whoami` | `gh api user --jq '.login'` |
| `labels` | `gh label list` |
| `label-create <name> <color> [desc]` | `gh label create "<name>" --color "<color>" --description "<desc>"` |
| `milestones` | `gh api repos/{owner}/{repo}/milestones --jq '.[] \| "\(.title) [open:\(.open_issues)/closed:\(.closed_issues)]"'` |
| `milestone-create <title> [desc]` | `gh api repos/{owner}/{repo}/milestones -f title="<title>" -f description="<desc>"` |

### Output Contracts (gitea.ts → gh)

Each command's exact output format and the `gh` invocation that matches it.

#### `issue <id>` — Most used command (11 callers)

**gitea.ts output:**
```
#436 [open] SRP: Extract orchestration from ImportService
labels: priority/high, scope/backend, scope/services, status/in-progress, type/chore, yolo | milestone: Tech Debt Phase 5 — Code Health

## Problem
(full body follows)
```

**Scripts parse:** `labels:` line for label names, `#\d+` for issue number, `[open|closed]` for state

**gh equivalent:**
```bash
gh issue view 436 --json number,state,title,labels,milestone,body \
  --jq '"#\(.number) [\(.state)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'
```

#### `issues [all]` — List issues

**gitea.ts output:**
```
#436 [open] SRP: Extract orchestration from ImportService
   labels: priority/high, scope/backend | milestone: Tech Debt Phase 5
#435 [open] SRP: Extract orchestration from QualityGateService
   labels: priority/high, scope/backend
```

**gh equivalent:**
```bash
gh issue list --state open --limit 50 --json number,state,title,labels,milestone \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)\n   labels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)"'
```

#### `issue-comments <id>` — Comments with structured format

**gitea.ts output:**
```
--- comment 9776 | claude | 2026-03-17T21:57:39Z ---
(comment body)

--- comment 9812 | pr_reviewer | 2026-03-17T22:25:34Z ---
(comment body)
```

**Scripts parse:** `--- comment <id> | <username> | <date> ---` header, then body until next header. `parseComments()` in lib.ts splits on this pattern.

**gh equivalent:**
```bash
gh api repos/{owner}/{repo}/issues/436/comments --paginate \
  --jq '.[] | "--- comment \(.id) | \(.user.login) | \(.created_at) ---\n\(.body)\n"'
```

#### `issue-comment <id> --body-file <path>` — Post comment

**gitea.ts output:** `Comment added to #436`

**gh equivalent:**
```bash
gh issue comment 436 --body-file /tmp/comment.md
```
Note: `gh` prints the comment URL, not "Comment added to #N". Scripts checking for success should check exit code, not output text.

#### `issue-create <title> --body-file <path> <labels> <milestone>` — Create issue

**gitea.ts output:** Same as `issue <id>` (full issue detail with body)

**gh equivalent:**
```bash
gh issue create --title "Title" --body-file /tmp/body.md \
  --label "type/chore,priority/high" --milestone "Tech Debt Phase 5"
```
Note: `gh` prints the issue URL. To get full detail, follow with `gh issue view`.

#### `issue-update <id> labels <labels>` — Replace all labels

**gitea.ts output:** `Labels set: priority/high, scope/backend, status/in-progress`

**gh caveat:** `gh issue edit` has `--add-label` and `--remove-label` but no atomic "replace all labels." The scripts use Gitea's PUT (replace entire set). For `gh`, either:
- Clear and re-add: `gh issue edit <id> --remove-label "old1,old2" --add-label "new1,new2"`
- Or use API: `gh api repos/{owner}/{repo}/issues/<id>/labels -X PUT --input labels.json`

#### `issue-update <id> body --body-file <path>` — Update body

**gitea.ts output:** Full issue detail (same as `issue <id>`)

**gh equivalent:**
```bash
gh issue edit 436 --body-file /tmp/body.md
```

#### `issue-update <id> state closed` — Close issue

**gitea.ts output:** Full issue detail with `[closed]`

**gh equivalent:**
```bash
gh issue close 436
```

#### `pr <number>` — PR details

**gitea.ts output:**
```
#420 [open] #404 Discover — Series Completion Intelligence
feature/issue-404 → main | author: claude | sha: e7d79fe | https://git.tjiddy.com/todd/narratorr/pulls/420
labels: stage/review-pr, scope/backend

(full body follows)
```

**Scripts parse:** `author:` field, `sha:` field, `→` for head/base branches, `labels:` line, body for `Refs #N`/`Closes #N`

**gh equivalent:**
```bash
gh pr view 420 --json number,state,title,headRefName,baseRefName,author,headRefOid,url,labels,body \
  --jq '"#\(.number) [\(.state)] \(.title)\n\(.headRefName) → \(.baseRefName) | author: \(.author.login) | sha: \(.headRefOid) | \(.url)\nlabels: \([.labels[].name] | join(", "))\n\n\(.body // "")"'
```

#### `prs [all]` — List PRs

**gitea.ts output:**
```
#420 [open] #404 Discover — Series Completion Intelligence
   feature/issue-404 → main | https://git.tjiddy.com/...
```

**gh equivalent:**
```bash
gh pr list --state open --limit 50 --json number,state,title,headRefName,baseRefName,url \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)\n   \(.headRefName) → \(.baseRefName) | \(.url)"'
```

#### `pr-comments <number>` — PR comments

**gitea.ts output:** Same format as `issue-comments` (uses same endpoint)

**gh equivalent:**
```bash
gh api repos/{owner}/{repo}/issues/420/comments --paginate \
  --jq '.[] | "--- comment \(.id) | \(.user.login) | \(.created_at) ---\n\(.body)\n"'
```

#### `pr-comment <number> --body-file <path>` — Post PR comment

**gitea.ts output:** `Comment added to PR #420`

**gh equivalent:**
```bash
gh pr comment 420 --body-file /tmp/comment.md
```

#### `pr-merge <number> [squash]` — Merge PR

**gitea.ts output:** `PR #420 merged via squash`

**gh equivalent:**
```bash
gh pr merge 420 --squash --delete-branch
```

#### `pr-create <title> --body-file <path> <head> [base]` — Create PR

**gitea.ts output:** `PR #421 created: https://...`

**gh equivalent:**
```bash
gh pr create --title "Title" --body-file /tmp/body.md --head feature/branch --base main
```

#### `pr-update-labels <number> <labels>` — Replace PR labels

Same caveat as `issue-update labels` — `gh` doesn't have atomic replace. Use `gh pr edit` with `--add-label`/`--remove-label`, or `gh api` with PUT.

#### `commit-status <ref>` — CI status

**gitea.ts output:**
```
CI: success (3 checks)
  CI / quality-gates: success
```
Or: `CI: no status checks found for main`

**gh equivalent:**
```bash
gh api repos/{owner}/{repo}/commits/<ref>/status \
  --jq 'if .total_count == 0 then "CI: no status checks found for <ref>" else "CI: \(.state) (\(.total_count) checks)\n\(.statuses[] | "  \(.context): \(.state)")" end'
```

#### `whoami` — Authenticated username

**gitea.ts output:** `todd` (just the username)

**gh equivalent:**
```bash
gh api user --jq '.login'
```

#### `runs [branch] [--limit N]` — CI runs

**gitea.ts output:**
```
✓ #42 Fix Docker build 3a1b2c3
✗ #41 Add search tests e7d79fe
```

**gh equivalent:**
```bash
gh run list --limit 10 --json databaseId,displayTitle,headSha,conclusion \
  --jq '.[] | "\(if .conclusion == "success" then "✓" elif .conclusion == "failure" then "✗" else "●" end) #\(.databaseId) \(.displayTitle) \(.headSha[:7])"'
```

#### `run-log <run-number>` — CI run logs

**gitea.ts** strips timestamps and infrastructure noise. `gh` equivalent:
```bash
gh run view <run-id> --log
```
Note: `gh` log output is verbose. May want to pipe through a similar noise filter, or use `--log-failed` to only see failures.

#### `label-create`, `labels`, `milestones`, `milestone-create`, `search`

These are low-frequency admin commands. The command mapping table above covers them. No special output parsing needed.

### Files to Update

**Scripts (programmatic callers — rewrite `gitea()` helper in lib.ts):**
- `scripts/lib.ts` — Replace `gitea()` wrapper with `gh()` wrapper
- `scripts/claim.ts` — Uses: issue, issue-comments, prs, issue-update, issue-comment
- `scripts/block.ts` — Uses: issue, issue-comment, issue-update
- `scripts/resume.ts` — Uses: issue, issue-comments, issue-update, issue-comment
- `scripts/merge.ts` — Uses: pr, pr-comments, commit-status, issue, issue-update, issue-comment, pr-merge, pr-update-labels, issue-update state
- `scripts/changelog.ts` — Uses: issue (multiple calls per commit)
- `scripts/setup-labels.ts` — Uses: label-create (14 calls)
- `scripts/update-labels.ts` — Uses: pr/issue, pr-update-labels/issue-update

**Skills (LLM callers — update `node scripts/gitea.ts` references):**
- `.claude/skills/issue/SKILL.md` — issue
- `.claude/skills/issues/SKILL.md` — issues
- `.claude/skills/plan/SKILL.md` — issue, issue-comments, prs, issue-comment
- `.claude/skills/implement/SKILL.md` — issue, pr
- `.claude/skills/handoff/SKILL.md` — issue, pr
- `.claude/skills/spec/SKILL.md` — issue-create
- `.claude/skills/elaborate/SKILL.md` — issue-comments, issue-update, issue-comment
- `.claude/skills/review-spec/SKILL.md` — issue, issue-comment
- `.claude/skills/review-pr/SKILL.md` — pr, pr-comments, whoami, pr-comment
- `.claude/skills/respond-to-spec-review/SKILL.md` — issue, issue-comments, issue-create, issue-update, issue-comment
- `.claude/skills/respond-to-pr-review/SKILL.md` — pr, pr-comments, pr-comment
- `.claude/skills/triage/SKILL.md` — (minimal, reads CL files)

**Docs:**
- `CLAUDE.md` — Gitea CLI Quick Reference section
- `README.md` — Gitea dev setup section

### Migration Strategy

1. Install `gh` on all machines (dev + yolo workers)
2. Rewrite `scripts/lib.ts` `gitea()` helper → `gh()` helper that shells out to `gh`
3. Update each script to use `gh` commands with appropriate `--json`/`--jq` flags
4. Update each skill to reference `gh` directly instead of `node scripts/gitea.ts`
5. Update CLAUDE.md quick reference
6. Test full workflow cycle: `/spec` → `/review-spec` → `/implement` → `/handoff` → `/review-pr`

## Lessons from POC Dry Run

1. **Clone, don't archive.** `git archive | tar` strips executable bits on Windows.
2. **Check file modes.** s6-overlay run script must be `100755`. Use `git update-index --chmod=+x`.
3. **Workflow tests are brittle to registry changes.** When tags use `${{ env.IMAGE_NAME }}` interpolation, tests can't assert on the literal expanded string — assert on the env var definition + the template pattern instead.
4. **CL learnings reference Gitea paths.** These are internal tooling history and don't need updating for the public release — but be aware they exist.
5. **Gitea CI had `${{ vars.RUNNER_TYPE || 'ubuntu-latest' }}`.** GitHub doesn't need this — just use `ubuntu-latest` directly.