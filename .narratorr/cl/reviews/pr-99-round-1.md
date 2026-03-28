---
skill: respond-to-pr-review
issue: 99
pr: 119
round: 1
date: 2026-03-25
fixed_findings: [F1, F2, F3]
---

### F1: Pre-search blank-state assertions only negate text, not icons
**What was caught:** Tests asserted that empty-state text strings were absent but never checked that no icon (SVG) node was rendered, meaning a partial regression (icon without copy) would pass.
**Why I missed it:** During implementation I focused on removing the visible copy ("Start your search") and assumed negating the text was sufficient proof of a blank area. I didn't apply the "assert the full DOM surface, not just the primary text" mental model for blank-state verification.
**Prompt fix:** Add to `/implement` step 4 under "Test quality standards": "When writing blank-state tests (component returns null or renders empty), always assert *all* removed DOM surface — text nodes AND icon/SVG nodes. A text-absence assertion alone does not catch partially-removed states."

### F2: No-results blank-state assertion only negated the title, not description or icon
**What was caught:** The no-results EmptyState had three parts (title, description, icon). The test only negated the title, so a partially-removed state (description or icon left behind) would pass.
**Why I missed it:** Same root cause as F1 — I only negated the most visible string. The blast-radius checklist I updated was about which test files to delete/update, not about what to assert in the replacement tests.
**Prompt fix:** Add to CLAUDE.md § Gotchas: "**Blank-state assertions:** Negate ALL parts of the removed empty state (title text, description text, icon/SVG). `queryByText('X').not.toBeInTheDocument()` alone passes if the description or icon is accidentally preserved."

### F3: Route regression tests used renderWithProviders which doesn't populate Outlet
**What was caught:** `renderWithProviders(<Layout />, { route })` sets the MemoryRouter location but defines no nested Routes. Layout's `<Outlet>` renders nothing, so tests only verified navigation presence — not that route content renders inside `<main>`.
**Why I missed it:** I didn't read the `renderWithProviders` source before writing the tests. I assumed passing `{ route }` would produce route-matched content through the Outlet, but it only sets the initial URL — no route matching occurs without a `<Routes>` tree.
**Prompt fix:** Add to `/plan` step 5 (test stub generation): "For layout shell regression tests, note that `renderWithProviders(<Layout />, { route })` does NOT populate the Outlet — use `render()` directly with a `<Routes><Route element={<Layout />}>` tree so the Outlet renders child content that can be asserted inside `<main>`."
