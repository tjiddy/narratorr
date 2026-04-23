# Testing Standards

All new/changed code must include tests. Run `pnpm test` (Vitest) to execute all suites.

**Red/green TDD convention:** Implementation follows a strict red→green cycle per module. Before writing production code, create `it.todo()` stubs (or real failing tests) from the spec's interactions and system behaviors. For each module: (1) convert stubs to real failing tests with full assertions/mocks, (2) run the test file and **confirm tests fail** (if a test passes before implementation exists, the assertion is vacuous — fix it), (3) write production code until tests pass, (4) commit. This applies to both backend logic and frontend component behavior.

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
- **Assert arguments, not just invocation.** `expect(mock).toHaveBeenCalled()` proves nothing — the mock accepts any input. Always use `.toHaveBeenCalledWith(expectedArgs)`. For DB operations, assert both `.set()` payload values AND `.where()` predicates. For mutations, assert the exact ID/payload passed. A return-value-only assertion does not prove the contract is correct. Also assert absence — if an action should NOT fire a side effect, explicitly `expect(mock).not.toHaveBeenCalled()`.
- **Test the full mutation lifecycle.** Invocation alone is not coverage. For frontend mutations: assert pending state (button disabled, spinner), success effects (toast, cache invalidation via `queryClient.invalidateQueries`, form reset, modal close), AND error effects (error toast, optimistic rollback, UI recovery). For backend mutations: assert DB writes, event emissions, and error responses.
- **Vacuous tests are bugs.** If a test passes before the production code exists (step 2 of red/green TDD), the assertion is wrong — it will never catch a regression. Before trusting a negative assertion (`not.toBeInTheDocument`), verify the positive case works first. Before trusting a mock assertion, verify the mock is actually wired to the code path.
- **Assert consequences, not implementation.** Don't assert CSS classes or internal state. Assert what the user sees (text, visibility, disabled behavior) and what the system does (API called with correct args, navigation occurred, toast appeared). Test the contract, not the wiring.
- **Mock at the API boundary.** Mock `api.*` methods or use MSW — never mock child components or hooks. The more of the real component tree that executes, the more bugs you catch. If a test mocks a child component, it's testing nothing useful.
- **Every new branch gets a test.** Each new `if/else`, `switch` case, `try/catch`, or validation error path is a testable behavior. When adding `zodResolver` validation, test invalid submission (not just happy path). When adding a `catch` block, trigger the error condition. When adding env-dependent logic (`isDev`, `NODE_ENV`), test both branches — don't rely on the default test environment.
- **Test every layer you changed.** When a change spans route + service, test at BOTH boundaries. When adding a callback prop from parent → child, test the child interaction AND the parent wiring. Partial-layer coverage is the #1 cause of review ping-pong.
- **Every error path gets a test.** API rejection → user sees error message. Empty data → empty state renders. Network failure mid-flow → UI recovers gracefully. If a catch block exists, a test should trigger it.
- **Interaction chains over snapshots.** The highest-value tests exercise a full flow: action → state change → UI update → API call → response → UI update. These catch the integration bugs that unit tests miss.
- **Read source before writing assertions.** When testing components that format or transform values, read the formatter/helper source first to understand edge cases (zero values, boundary conditions, format skipping). Most test assertion mismatches come from assuming output format without checking.
- **Path assertions must normalize separators.** `path.join()` produces backslashes on Windows but forward slashes on Linux. Never use `toBe()` or `toHaveBeenCalledWith()` with hardcoded forward-slash paths — normalize actual values with `.split('\\').join('/')` before comparing, or use `expect.stringContaining()`.

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

**Required before PR:** `pnpm verify` (runs `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`).
