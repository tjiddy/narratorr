# Contributing to Narratorr

This guide covers the development workflow, conventions, and tooling for contributing to Narratorr — whether you're a human, Claude Code, Cursor, or any other AI agent.

## Getting Started

```bash
git clone https://github.com/tjiddy/narratorr.git
cd narratorr
pnpm install
pnpm dev           # API on :3000, Vite on :5173
```

## GitHub Project Management

All work is tracked as issues on [GitHub](https://github.com/tjiddy/narratorr/issues). Each issue is self-contained — the spec, acceptance criteria, and test plan live in the issue body.

### CLI Tool

We use the [GitHub CLI (`gh`)](https://cli.github.com/) for all issue and PR interactions:

```bash
gh issue list                        # List open issues
gh issue view <id>                   # Read full issue (spec, AC, test plan)
gh issue edit <id> --add-label X     # Add labels
gh issue comment <id> -b "msg"       # Comment on issue
gh pr list                           # List open PRs
gh pr view <number>                  # Read PR details
gh pr create --title "..." --body "..."  # Create PR
gh pr comment <number> -b "msg"      # Comment on PR
```

### Labels (2-axis model)

Issues use two exclusive label groups:

**Status** (lifecycle — exactly one):
`status/backlog` → `status/review-spec` ↔ `status/fixes-spec` → `status/ready-for-dev` → `status/in-progress` → `status/in-review` → `status/done`

**Stage** (pipeline — exactly one, on the PR):
`stage/review-pr` ↔ `stage/fixes-pr` → `stage/approved`

**Standalone flags** (additive, not exclusive):
- `blocked` — something is preventing progress (overlays current status)
- `yolo` — enables autonomous orchestration (narrator-yolo)

Other labels: `type/feature` · `type/bug` · `type/chore` | `priority/high` · `priority/medium` · `priority/low` | `scope/backend` · `scope/frontend` · `scope/core` · `scope/db` · `scope/infra` · `scope/api` · `scope/services` · `scope/ui`

---

## Issue Lifecycle

Every issue follows this lifecycle. No shortcuts.

### 1. Validate the spec

Before writing any code, verify the issue has:
- **Acceptance Criteria** — clear, testable statements (REQUIRED)
- **Test Plan** — specific test cases (REQUIRED)
- **Implementation detail** — file paths, interfaces, wiring points (recommended)
- **Dependencies** — any referenced issues should be `status/done`

If the spec is incomplete and you can fill gaps from codebase knowledge, update the issue body (preserve existing content, append new sections). If it needs human input, comment with what's missing and set `blocked`.

### 2. Check for conflicts

- `gh pr list` — any open PR touching the same area?
- Any `status/in-progress` issues that overlap?

If conflicts exist, stop and flag them.

### 3. Claim the issue

Post a claim comment on the issue:
```
**Claiming #<id>**
- Plan:
    1. ...
    2. ...
- Expected changes: `<files/modules>`
- Verification: `<tests to run>`
```

Update labels:
```bash
gh issue edit <id> --add-label "status/in-progress" --remove-label "status/ready-for-dev"
```

### 4. Create a branch

```bash
git checkout main && git pull
git checkout -b feature/issue-<id>-<slug>
```

Branch naming: `feature/issue-<id>-<kebab-case-summary>` (e.g., `feature/issue-58-newznab-indexer`)

### 5. Implement

- Follow the Acceptance Criteria as a checklist
- Write tests for all new/changed code (see Testing section below)
- Commit with `#<id>` prefix: `#58 Add Newznab search adapter`
- Stay in scope — if requirements expand, stop and flag it

### 6. Run quality gates

All four must pass before opening a PR:

```bash
pnpm lint        # ESLint
pnpm test        # Vitest (all packages)
pnpm typecheck   # TypeScript strict
pnpm build       # Full build
```

Or run them all at once: `node scripts/verify.ts`

### 7. Push and create PR

```bash
git push -u origin $(git branch --show-current)
```

PR title: `#<id> <issue title>`
PR body must include `Closes #<id>` and these sections:

```markdown
Closes #<id>

## Summary
- <what changed>

## Acceptance Criteria
- [ ] <from the issue spec>

## Tests / Verification
- Commands: <what was run>
- Manual: <what was checked>

## Risk / Rollback
- Risk: low — <rationale>
- Rollback: revert PR
```

### 8. Hand off

After creating the PR:
- Update labels: add `stage/review-pr` to the PR, set `status/in-review` on the issue
- Comment on the issue with PR link + what changed + how verified
- Switch back to main: `git checkout main`

---

## Architecture Overview

```
src/
  server/
    routes/       — Fastify route handlers (export async function, take app + services)
    services/     — Business logic classes (constructor: db + logger)
    jobs/         — Background tasks
  client/
    pages/        — React page components
    components/   — Shared UI components
    lib/          — API client, utilities
  shared/         — Zod schemas and registries shared between client and server
  core/
    indexers/     — Search adapter implementations (IndexerAdapter interface)
    download-clients/  — Download client implementations (DownloadClientAdapter interface)
    metadata/     — Metadata provider implementations (MetadataProvider interface)
    utils/        — Shared utilities (parsing, naming, magnets)
  db/
    schema.ts     — Drizzle ORM schema (SQLite)
```

### Key patterns

**Services** use constructor injection with `(db: Db, log: FastifyBaseLogger)`. Some take additional service deps. All instantiated in `routes/index.ts:createServices()`.

**Adapters** (indexers, download clients, metadata) implement interfaces from `src/core/*/types.ts`. They do NOT use a logger — throw errors or return failures; the calling service logs.

**Routes** are registered in `routes/index.ts:registerRoutes()`. Each route file exports an async function taking `(app, ...services)`.

**Frontend** uses React Router (routes in `App.tsx`), nav items in `Layout.tsx`, TanStack Query for server state, Tailwind for styling.

---

## Testing

All new/changed code must include tests.

| Layer | Location | Pattern | Example |
|-------|----------|---------|---------|
| Service (mock DB) | `services/*.test.ts` | Mock db + logger, test business logic | `book.service.test.ts` |
| Route (integration) | `routes/*.test.ts` | Fastify `inject()`, mock services | `search.test.ts` |
| Core adapter (HTTP mock) | `src/core/**/*.test.ts` | MSW `setupServer()` | `abb.test.ts` |
| Frontend component | `**/*.test.tsx` | `renderWithProviders` helper | `SearchPage.test.tsx` |
| Frontend hook | `hooks/*.test.tsx` | `renderHook` + wrapper | `useLibrary.test.tsx` |

Global test setup: `src/client/__tests__/setup.ts`
Test helpers: `src/client/__tests__/helpers.tsx` (`renderWithProviders`)

---

## Code Style

- TypeScript strict mode, ESM (`.js` extensions in imports)
- Functional React components
- TanStack Query for server state (no raw `fetch` in components)
- Tailwind CSS (no CSS files)
- `@/` path alias for client imports
- Logger type: `FastifyBaseLogger` from `fastify` (not `BaseLogger` from `pino`)

### Logging guidelines

| Level | When |
|-------|------|
| `error` | Unexpected failures (uncaught exceptions, DB errors, broken APIs) |
| `warn` | Recoverable issues (one indexer failed, missing optional config) |
| `info` | Significant operations (CRUD, downloads, job lifecycle, settings changed) |
| `debug` | Diagnostic detail (API payloads, query params, intermediate state) |

Every catch block must log. Every create/update/delete should log at info. Core adapters (`src/core/`) do NOT log — they throw or return failures.

---

## Blocked Workflow

When you can't proceed:

1. Comment on the issue with the `BLOCKED` template:
```
**BLOCKED — need input**

Context: <what you tried and where you got stuck>

Decision needed:
1. <Question>?
    - A) ...
    - B) ...
    - Default if no answer: A
```

2. Add the `blocked` label (keep current `status/*`)
3. Stop working

### Resuming a blocked issue

1. Read the issue and find the most recent `BLOCKED` comment
2. Read comments posted after it for answers
3. Check out the existing branch: `git checkout feature/issue-<id>-*`
4. Remove the `blocked` label
5. Continue implementation

---

## Workflow Scripts

Mechanical workflow steps are deterministic Node scripts in `scripts/`. These run without an LLM:

| Script | What it does | Output |
|--------|-------------|--------|
| `node scripts/verify.ts` | lint → test+coverage → typecheck → build | `VERIFY: pass/fail` |
| `node scripts/claim.ts <id>` | Validate status, create branch, update labels | `CLAIMED:/ERROR:` |
| `node scripts/merge.ts <pr>` | Validate approval, CI, squash merge, close issue | `MERGED:/ERROR:` |
| `node scripts/block.ts <id> "<reason>"` | Post blocker comment, update labels | `BLOCKED:` |
| `node scripts/resume.ts <id>` | Restore branch, collect context | Branch + context |
| `node scripts/changelog.ts [since]` | Categorized changelog from git + GitHub | Markdown |

## Claude Code Skills

If you're using Claude Code, workflow skills automate the steps above. Some are thin wrappers around the scripts above, others use LLM reasoning:

| Skill | What it does |
|-------|-------------|
| `/implement <id>` | Full lifecycle: claim → plan → implement → verify → handoff |
| `/plan <id>` | JIT elaboration: explore codebase, extract test stubs, post plan |
| `/handoff <id>` | Self-review, coverage review, verify, push, create PR, update labels |
| `/elaborate <id>` | Groom/validate issue spec (read-only) |
| `/review-pr <pr>` | Review PR against linked issue AC |
| `/respond-to-pr-review <pr>` | Address PR review findings |
| `/respond-to-spec-review <id>` | Address spec review findings |
| `/triage` | Rank and categorize open issues |
| `/claim <id>` | Wrapper: runs `scripts/claim.ts` |
| `/verify` | Wrapper: runs `scripts/verify.ts` |
| `/block <id>` | Gathers reason from user, then runs `scripts/block.ts` |
| `/resume <id>` | Wrapper: runs `scripts/resume.ts`, presents context |
| `/merge <pr>` | Wrapper: runs `scripts/merge.ts` |
| `/changelog [since]` | Wrapper: runs `scripts/changelog.ts` |

These are optional conveniences — the workflow steps above work with any tool.
