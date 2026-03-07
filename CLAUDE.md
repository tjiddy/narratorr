# CLAUDE.md

## Project Overview

Narratorr is a self-hosted audiobook management application ("*arr for audiobooks"). Searches indexers, sends downloads to torrent clients, imports into a library folder structure.

## Project Philosophy

Narratorr uses AI-assisted development extensively — AI agents author PRs, review code, and run quality gates. Human oversight focuses on architecture, priorities, and product direction rather than line-by-line review. This works because the project invests heavily in the things that make *any* codebase reliable: thorough tests, clean architecture, and precise specifications.

**Principles:**
- **Tests are first-class deliverables.** Every new file gets a test file. Every error path gets a test. Tests are the primary safety net against regressions — treat them with the same care as production code. When in doubt, over-test.
- **Test what matters.** Every test should exist because it could catch a real defect. A validation error test that catches a broken form schema is valuable. A pointless interaction tacked onto a render assertion to satisfy a coverage rule is noise. Optimize for defect detection, not metric compliance.
- **Structure enables safe changes.** Clean separation of concerns, consistent patterns, and co-located code mean any contributor (human or AI) can pick up an issue and implement it without breaking unrelated things. When the architecture is right, changes are small and localized.
- **Specs are contracts.** Acceptance criteria are precise enough that the implementer and the reviewer interpret them the same way. Ambiguous specs lead to wasted cycles. If a requirement is unclear, clarify it before building.

## Tech Stack

pnpm | Node.js 20+ | Fastify 5 | Drizzle ORM + libSQL | React 18 + Vite 6 | TanStack Query | Tailwind CSS | Docker

## Project Structure

- `src/server/` — Fastify backend (routes/, services/, jobs/, config.ts, index.ts)
- `src/client/` — React frontend (pages/, components/, lib/api/, App.tsx)
- `src/shared/` — Shared Zod schemas and registries
- `src/core/` — Indexer + download client adapters (indexers/, download-clients/, utils/)
- `src/db/` — Drizzle schema (schema.ts), client, migrations

## Commands

```bash
pnpm install       # Install deps
pnpm dev           # Dev servers (API :3000, Vite :5173)
pnpm build         # Build all
pnpm db:generate   # Generate Drizzle migration after schema change
pnpm typecheck     # TypeScript checking
```

## Architecture

- **Services**: Business logic classes in `services/`, instantiated in `routes/index.ts`. See existing services for pattern.
- **Adapters**: Indexers and download clients implement interfaces in `src/core/*/types.ts`.
- **Routes**: Fastify route files export async functions taking app + services. Registered in `routes/index.ts`.
- **Frontend pages**: Components in `pages/`, routes in `App.tsx`, nav in `components/layout/Layout.tsx`.
- **Database**: Edit `src/db/schema.ts` → run `pnpm db:generate` → migrations auto-run on start.

## Design Principles

- **Single responsibility.** Each file, component, and service should have one reason to change. If modifying indexer settings requires editing the same file as download client settings, that's an SRP violation — split them. A long file that does one thing well is fine; a short file that mixes concerns is not.
- **Don't repeat yourself.** If three CRUD sections share identical mutation/query/toast patterns, extract a shared hook or component. Duplication is a stronger signal than file length.
- **Open for extension, closed for modification.** Adding a new feature (adapter, settings section, notifier type) should mean creating new files, not modifying a growing list in existing ones. If wiring a feature requires touching 4+ existing files, the architecture needs a registry/plugin pattern.
- **Co-locate what changes together.** Types live alongside their API methods. Components live with their hooks. Tests live next to their source. Barrel `index.ts` at module boundaries, direct imports within.
- **Extract components and hooks, not just functions.** When a component grows a second concern, extract it to its own file — don't just extract a helper function within the same file. React components and hooks are the unit of reuse.

**Mechanical checks:** `.claude/docs/architecture-checks.md` defines greppable SOLID and DRY checks (wiring cost, growing switches, interface contract violations, parallel types, etc.). These are run by `/spec`, `/plan`, `/review-pr`, and `/review-spec` at appropriate stages.

## Frontend Design Quality

All issues with `scope/frontend` must include a UI/UX design pass during implementation. New or significantly changed UI components should be refined using the `frontend-design` skill before handoff. The goal is production-grade polish — not just functional markup. This is enforced at two points:
- `/implement` runs the design pass proactively after quality gates pass
- `/review-pr` checks that frontend components meet the app's design standard and flags unpolished UI as a blocking finding

## Security

See `docs/SECURITY.md` for the full security model. Key architectural decisions:

- **Filesystem browsing is intentionally unrestricted** for authenticated users. Narratorr is a single-user self-hosted app — the authenticated user is the server operator. Restricting browse to a preconfigured root would break setup workflows. This matches Sonarr/Radarr/Lidarr behavior.
- **All `/api/*` routes require auth** (when enabled) except: `/health`, `/system/status`, `/auth/status`, `/auth/login`, `/auth/logout`, and `/auth/setup` (only when no user exists).
- **Passwords use scrypt** with random salts and timing-safe comparison. Session cookies are HMAC-SHA256 signed.

## Code Style

TypeScript strict, ESM (`.js` extensions), functional React components, TanStack Query for server state, Tailwind CSS (no CSS files), `@/` path alias for client imports. Always use `return await` (not bare `return`) for async calls inside try/catch blocks — without `await`, the catch block is dead code for rejected promises.

## Logging

Uses Fastify's built-in Pino logger. Log level is configurable at Settings > General.

**Level guidelines:**
- `error` — Unexpected failures needing attention (uncaught exceptions, DB errors, broken external APIs)
- `warn` — Recoverable issues (one indexer failed, missing optional config, silent fallbacks)
- `info` — Significant operations (CRUD, downloads started/completed, job lifecycle, settings changed)
- `debug` — Diagnostic detail (API payloads, query params, intermediate state)

**Where to log:**
- Routes: use `request.log.info(...)` / `request.log.error(error, '...')`
- Services: use `this.log.info(...)` (injected `FastifyBaseLogger` via constructor)
- Jobs: use the `log` instance passed at initialization
- Core adapters (`src/core/`): do NOT use a logger — throw errors or return failures; the calling service logs, UNLESS it makes sense to do so.

**Important:** Use `FastifyBaseLogger` from `fastify` for logger types — NOT `BaseLogger` from `pino`. Pino is a transitive dependency (not directly installed), so importing from it causes TypeScript errors.

**When adding new code:** Always add appropriate log statements. Every catch block must log. Every create/update/delete should log at info. External API call failures should log at warn or error.

## Testing

All new/changed code must include tests. Run `pnpm test` (Vitest) to execute all suites.

**Test-first convention:** When implementing spec behaviors, write stub test cases _before_ the implementation. Each acceptance criterion or behavioral requirement from the spec becomes a failing test first, then code to make it pass. This applies to both backend logic and frontend component behavior. The goal isn't full TDD — it's ensuring spec requirements have explicit test coverage before the implementation is "done."

**Conventions:**
- Co-located test files: `foo.ts` → `foo.test.ts` (or `.test.tsx` for JSX)
- Backend services: mock DB, test business logic (`services/*.test.ts`)
- API routes: Fastify `inject()` integration tests (`routes/*.test.ts`)
- Core adapters: MSW for HTTP mocking (`src/core/**/*.test.ts`)
- Frontend components: Testing Library render tests (`*.test.tsx`)
- Frontend hooks: `renderHook` from Testing Library (`*.test.ts(x)`)
- Global setup (client): `src/client/__tests__/setup.ts` (matchMedia mock, auto-cleanup)
- Test helpers: `src/client/__tests__/helpers.tsx` (`renderWithProviders`)

**Test quality standards:**
- **Test user flows, not rendering.** Interactive components (forms, buttons, toggles, modals) must include `userEvent` interactions that exercise the component's behavior. Render-only assertions are valid when testing a distinct render *condition* — conditional field visibility based on type, warning messages based on prop/state, empty states, error messages from validation. The test should still assert something meaningful. Good: `"shows empty state message when list is empty"` — asserts a specific render condition. Bad: `"it renders"` with no expectation about what rendered. The distinction: "does this component respond to user input?" → needs interaction. "Does this component show the right thing given these inputs?" → render assertion is fine.
- **Assert consequences, not implementation.** Don't assert CSS classes or internal state. Assert what the user sees (text, visibility, disabled behavior) and what the system does (API called with correct args, navigation occurred, toast appeared). Test the contract, not the wiring.
- **Mock at the API boundary.** Mock `api.*` methods or use MSW — never mock child components or hooks. The more of the real component tree that executes, the more bugs you catch. If a test mocks a child component, it's testing nothing useful.
- **Every error path gets a test.** API rejection → user sees error message. Empty data → empty state renders. Network failure mid-flow → UI recovers gracefully. If a catch block exists, a test should trigger it.
- **Interaction chains over snapshots.** The highest-value tests exercise a full flow: action → state change → UI update → API call → response → UI update. These catch the integration bugs that unit tests miss.
- **Read source before writing assertions.** When testing components that format or transform values, read the formatter/helper source first to understand edge cases (zero values, boundary conditions, format skipping). Most test assertion mismatches come from assuming output format without checking.

**Test plan completeness standard:** Test plans in issue specs must cover these categories where applicable:
- **Schema validation** — positive and negative cases (valid input accepted, invalid input rejected with correct error)
- **Boundary values** — zero, exactly-at-threshold (inclusive/exclusive), null/undefined/missing fields, empty arrays/strings
- **Null/missing data paths** — what happens when optional fields are absent, when calculations can't be performed, when external data is unavailable
- **Filter/feature interactions** — when multiple filters combine, when features overlap (e.g., quality floor + protocol preference + min seeders all applied to same result set)
- **Error isolation** — fire-and-forget failures don't break the parent operation, catch blocks are exercised, API rejections surface user-visible errors
- **Transient vs persisted state** — flags that trigger actions but aren't stored, UI defaults that come from settings, values that change between request and processing
- **Race conditions & stale data** — concurrent operations on the same resource, data changing between read and use
- **End-to-end flows** — at least one integration test per user interaction that exercises the full path (UI action → API call → service logic → DB/external system → response → UI update)

Not every category applies to every issue. The standard is: if a category is relevant and missing, the test plan has a gap.

**Coverage gate:** `/verify` runs coverage on files changed in the branch. Any source file (non-test) at 0% coverage is a hard block on handoff. This catches entirely untested new code — not a substitute for behavioral tests, but a safety net against shipping with no tests at all.

**Required before PR:** `pnpm lint`, `pnpm test` (zero failures), `pnpm typecheck`, `pnpm build`.

## Project Management (Gitea)

All work is tracked as Gitea issues at `https://git.tjiddy.com/todd/narratorr`. Specs live in issue bodies — each issue is self-contained. The Gitea CLI is at `scripts/gitea.ts` — use `/issue <id>`, `/issues`, etc.

**Gitea connectivity is intermittent.** The Gitea server occasionally refuses connections (ECONNREFUSED on :443). If a Gitea CLI command fails with a connectivity error, wait 3 seconds and retry up to 3 times before giving up. This applies to all `gitea` commands — comments, label updates, PR creation, etc.

### Workflow Skills

Claude Code skills automate the agent workflow — use these instead of manual steps:

- `/implement <id>` — Full lifecycle: claim → plan → implement → handoff (preferred for end-to-end work)
- `/claim <id>` — Validate status + create branch + update labels (mechanical claiming)
- `/plan <id>` — JIT elaboration: explore codebase, extract test stubs, post implementation plan
- `/handoff <id>` — Verify, push, create PR, post handoff comment, update context cache
- `/block <id>` — Post blocked comment, set blocked label, stop
- `/elaborate <id>` — Groom/validate an issue spec (read-only, structured verdict)
- `/spec` — Create a new Gitea issue from the spec template
- `/verify` — Run quality gates (lint, test, typecheck, build) with structured summary
- `/review-pr <pr>` — Review a PR against its linked issue's acceptance criteria; auto-merges on approve, stops on needs-work
- `/review-spec <id>` — Review an issue spec against project standards; posts structured findings
- `/respond-to-pr-review <pr>` — Address PR review findings: fix, accept, defer, or dispute each finding, push fixes, post structured response
- `/respond-to-spec-review <id>` — Address spec review findings: update spec body, post structured response
- `/merge <pr>` — Merge an approved PR (checks verdict, quality gates, updates issue labels, cleans up branch)
- `/triage` — Rank and categorize all open issues (read-only)
- `/resume <id>` — Resume a blocked issue (restore branch, update labels)
- `/changelog [since]` — Generate categorized changelog from git history

## ⚠ Issue Workflow — MANDATORY

**Every task referencing a Gitea issue (#N) MUST follow this lifecycle — no exceptions.**
A detailed plan, pre-made spec, or explicit implementation instructions do NOT bypass these steps.

**Full auto (preferred):**
1. `/implement <id>` — claims, plans, implements, and hands off in one pass

**Manual control:**
1. **Before writing any code** → `/claim <id>` (validates status, creates branch, updates labels)
2. **Plan** → `/plan <id>` (explores codebase, extracts test stubs, posts implementation plan)
3. **Implement** — follow the plan from step 2
4. **After tests/typecheck/build pass** → `/handoff <id>` (pushes, creates PR, comments, updates labels, appends workflow log)

**PR review cycle:**
1. `/review-pr <pr>` — reviewer posts structured findings with verdict
2. `/respond-to-pr-review <pr>` — author addresses each finding (fix/accept/defer/dispute), pushes, posts response
3. `/review-pr <pr>` — re-review after fixes (repeat until approved)
4. `/merge <pr>` — squash merge once verdict is `approve`

**Standalone tools:**
- `/elaborate <id>` — groom/triage without claiming (no side effects)
- `/block <id>` — mark blocked and stop (at any point)

Skipping `/claim` means no validation, no branch, no tracking, no audit trail.
Skipping `/handoff` means no PR, no label update, no workflow log entry.

**Workflow guardrails:**
- **No pausing between sub-skills.** When `/claim`, `/plan`, `/verify`, or `/handoff` returns inside a parent skill (`/implement`, `/respond-to-pr-review`), immediately continue the parent flow. These are mid-flow return values, not stopping points.
- **Self-review guard.** `/review-pr` checks the current user against the PR author — if they match, it STOPs and suggests `/respond-to-pr-review` instead.
- **Merge author validation.** `/merge` requires the most recent `approve` verdict to come from a different user than the PR author. Stale approvals (superseded by `needs-work`) are ignored.
- **Dispute escalation.** If `/respond-to-pr-review` disputes a blocking finding, the issue goes `status/blocked` + `stage/review-pr` and STOPs for human input.
- **Auto-maintained files.** `/handoff` prepends to `.claude/workflow-log.md`.

### Labels (2-axis model)

Labels use `/` separators. Two exclusive groups track workflow state:

- **Status** (lifecycle — exactly one): `status/backlog` · `status/ready` · `status/ready-for-dev` · `status/elaborating` · `status/review-spec` · `status/fixes-spec` · `status/in-progress` · `status/blocked` · `status/done`
- **Stage** (pipeline — exactly one when in-progress): `stage/dev` · `stage/review-pr` · `stage/fixes-pr` · `stage/approved` · `stage/qa`
- **Gate**: `yolo` — enables autonomous orchestration (narrator-yolo). Without it, skills run manually.

Legacy aliases (accepted on read, never written): `status/ready` → `status/ready-for-dev`, `stage/review` → `stage/review-pr`

Other labels: Type: `type/feature` · `type/bug` · `type/chore` | Priority: `priority/high` · `priority/medium` · `priority/low` | Scope: `scope/backend` · `scope/frontend` · `scope/core` · `scope/db`

### Milestones

v0.1 MVP Foundation (done) → v0.2 Metadata & Library (done) → v0.3 Complete Pipeline → v0.4 Ready for Others → v1.1 Post Go-live
