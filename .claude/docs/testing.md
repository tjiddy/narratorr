# Testing Standards

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

**Coverage gate:** `/verify` runs coverage on files changed in the branch. Any source file (non-test) at ≤5% line coverage is a hard block on handoff. The threshold is >0% intentionally — files at 1-3% are typically just import/evaluation side effects, not real tests. This catches code shipped without meaningful test coverage.

**Required before PR:** `pnpm lint`, `pnpm test` (zero failures), `pnpm typecheck`, `pnpm build`.
