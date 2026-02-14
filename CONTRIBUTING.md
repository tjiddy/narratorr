# Contributing to Narratorr

This guide covers the development workflow, conventions, and tooling for contributing to Narratorr — whether you're a human, Claude Code, Cursor, or any other AI agent.

## Getting Started

```bash
git clone https://git.tjiddy.com/todd/narratorr.git
cd narratorr
pnpm install
pnpm dev           # API on :3000, Vite on :5173
```

## Gitea Project Management

All work is tracked as issues on [Gitea](https://git.tjiddy.com/todd/narratorr/issues). Each issue is self-contained — the spec, acceptance criteria, and test plan live in the issue body.

### CLI Tool

A TypeScript CLI wraps the Gitea API for quick access. Requires a `.env` file with `GITEA_TOKEN`, `GITEA_URL`, `GITEA_OWNER`, `GITEA_REPO` (see README for setup).

```bash
pnpm gitea issues                    # List open issues
pnpm gitea issue <id>                # Read full issue (spec, AC, test plan)
pnpm gitea issue-update <id> <field> <value>  # Update (state/labels/milestone/title/body)
pnpm gitea issue-comment <id> "msg"  # Comment on issue
pnpm gitea prs                       # List open PRs
pnpm gitea pr <number>               # Read PR details
pnpm gitea pr-create <title> <body> <head> [base]  # Create PR
pnpm gitea pr-comment <number> "msg" # Comment on PR
```

All body arguments support `--body-file <path>` to read content from a file (avoids shell escaping with multiline content).

### Labels (2-axis model)

Issues use two exclusive label groups:

**Status** (lifecycle — exactly one):
`status/backlog` → `status/ready` → `status/in-progress` → `status/done`
↘ `status/blocked` (at any point)

**Stage** (pipeline — exactly one when in-progress):
`stage/dev` → `stage/review` → `stage/qa`

Other labels: `type/feature` · `type/bug` · `type/chore` | `priority/high` · `priority/medium` · `priority/low` | `scope/backend` · `scope/frontend` · `scope/core` · `scope/db`

---

## Issue Lifecycle

Every issue follows this lifecycle. No shortcuts.

### 1. Validate the spec

Before writing any code, verify the issue has:
- **Acceptance Criteria** — clear, testable statements (REQUIRED)
- **Test Plan** — specific test cases (REQUIRED)
- **Implementation detail** — file paths, interfaces, wiring points (recommended)
- **Dependencies** — any referenced issues should be `status/done`

If the spec is incomplete and you can fill gaps from codebase knowledge, update the issue body (preserve existing content, append new sections). If it needs human input, comment with what's missing and set `status/blocked`.

### 2. Check for conflicts

- `pnpm gitea prs` — any open PR touching the same area?
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

Set labels to `status/in-progress` + `stage/dev`:
```bash
pnpm gitea issue-update <id> labels "status/in-progress,stage/dev,type/feature,..."
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

### 7. Push and create PR

```bash
git push -u origin $(git branch --show-current)
```

PR title: `#<id> <issue title>`
PR body must include `Refs #<id>` and these sections:

```markdown
Refs #<id>

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
- Update labels: replace `stage/dev` with `stage/review`
- Comment on the issue with PR link + what changed + how verified
- Switch back to main: `git checkout main`

---

## Architecture Overview

```
apps/narratorr/src/
  server/
    routes/       — Fastify route handlers (export async function, take app + services)
    services/     — Business logic classes (constructor: db + logger)
    jobs/         — Background tasks
  client/
    pages/        — React page components
    components/   — Shared UI components
    lib/api.ts    — API client
  shared/
    schemas.ts    — Zod schemas shared between client and server

packages/
  core/src/
    indexers/     — Search adapter implementations (IndexerAdapter interface)
    download-clients/  — Download client implementations (DownloadClientAdapter interface)
    metadata/     — Metadata provider implementations (MetadataProvider interface)
    utils/        — Shared utilities (parsing, naming, magnets)
  db/src/
    schema.ts     — Drizzle ORM schema (SQLite)
  ui/             — Shared UI utilities (cn())
```

### Key patterns

**Services** use constructor injection with `(db: Db, log: FastifyBaseLogger)`. Some take additional service deps. All instantiated in `routes/index.ts:createServices()`.

**Adapters** (indexers, download clients, metadata) implement interfaces from `packages/core/src/*/types.ts`. They do NOT use a logger — throw errors or return failures; the calling service logs.

**Routes** are registered in `routes/index.ts:registerRoutes()`. Each route file exports an async function taking `(app, ...services)`.

**Frontend** uses React Router (routes in `App.tsx`), nav items in `Layout.tsx`, TanStack Query for server state, Tailwind for styling.

### Codebase context cache

`.claude/project-context.md` contains a pre-built summary of interfaces, service patterns, DB schema, test patterns, and recent changes. Read this before exploring the codebase from scratch — it saves significant time.

---

## Testing

All new/changed code must include tests.

| Layer | Location | Pattern | Example |
|-------|----------|---------|---------|
| Service (mock DB) | `services/*.test.ts` | Mock db + logger, test business logic | `book.service.test.ts` |
| Route (integration) | `routes/*.test.ts` | Fastify `inject()`, mock services | `search.test.ts` |
| Core adapter (HTTP mock) | `packages/core/**/*.test.ts` | MSW `setupServer()` | `abb.test.ts` |
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

Every catch block must log. Every create/update/delete should log at info. Core adapters (`packages/core/`) do NOT log — they throw or return failures.

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

2. Set label to `status/blocked` (keep current `stage/*`)
3. Stop working

### Resuming a blocked issue

1. Read the issue and find the most recent `BLOCKED` comment
2. Read comments posted after it for answers
3. Check out the existing branch: `git checkout feature/issue-<id>-*`
4. Update labels: `status/blocked` → `status/in-progress`
5. Continue implementation

---

## Claude Code Skills

If you're using Claude Code, workflow skills automate the steps above:

| Skill | What it does |
|-------|-------------|
| `/implement <id>` | Full lifecycle: validate → claim → implement → verify → handoff |
| `/claim <id>` | Validate spec + claim issue |
| `/handoff <id>` | Verify, push, create PR, update labels |
| `/block <id>` | Post blocked comment, set labels, stop |
| `/elaborate <id>` | Groom/triage without claiming (read-only) |
| `/verify` | Run quality gates with structured summary |
| `/review <pr>` | Review PR against linked issue AC |
| `/triage` | Rank and categorize open issues |
| `/resume <id>` | Resume a blocked issue |
| `/changelog [since]` | Generate changelog from git history |

These are optional conveniences — the workflow steps above work with any tool.
