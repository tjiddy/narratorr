---
skill: respond-to-pr-review
issue: 163
pr: 168
round: 1
date: 2026-03-27
fixed_findings: [F1, F2, F3]
---

### F1: ImportCard variant/icon wiring not asserted
**What was caught:** The existing ImportCard badge tests only checked label text (Matching, Matched, Review, No Match) — not the variant classes or icon presence. A wrong variant mapping would have passed all tests silently.

**Why I missed it:** During implementation, the existing tests passed after the migration (green after green), which felt like validation. I added className forwarding test to Badge itself but didn't think to add equivalent contract tests at the call sites. The coverage review subagent did flag these as "UNTESTED" but they were categorized as pre-existing — incorrect, since the variant MAPPING (confidenceVariant const object) is new code I wrote.

**Prompt fix:** Add to /implement step 4d (sibling enumeration): "When introducing a variant prop at a call site (e.g., `<Badge variant={confidenceVariant[x]}`), add a test that asserts the variant mapping at the component level — not just the resulting label text. Label text tests do not catch wrong-variant regressions."

### F2: BookEditModal className passthrough not asserted
**What was caught:** The "In library" badge test only checked text presence. It did not assert that the success classes, leading icon, or `shrink-0` className were applied — meaning regressions in className forwarding or variant mapping would be silent.

**Why I missed it:** I added a className forwarding test in Badge.test.tsx itself, which gave confidence the feature worked. I didn't follow through to assert the forwarded className at the BookEditModal call site specifically. "The abstraction is tested" ≠ "the wiring is tested."

**Prompt fix:** Add to CLAUDE.md (under Code Style or Testing): "When a shared component's className prop is used at a call site for layout purposes (e.g., `shrink-0`), add a test at that call site asserting the class is present on the rendered element. Testing the component in isolation does not verify the wiring."

### F3: Unrelated Modal.test.tsx stub included in PR
**What was caught:** The branch included Modal.test.tsx (placeholder stubs for issue #164) that was committed to fix a lint gate but is out of scope for #163. It expanded review surface unnecessarily.

**Why I missed it:** I committed the file to unblock lint (the untracked version had unused imports), then rationalized it as "just a stub file." The handoff should have flagged this more clearly as scope creep to be addressed differently. The real fix (removing the file entirely) is clean and the stubs will be recreated by /plan when #164 is claimed.

**Prompt fix:** Add to /handoff step 6 (pre-push audit): "If any committed file is unrelated to the issue (pre-existing stubs from another issue, lint cleanup of a file not in scope), remove it from the branch with `git rm` before pushing. Check that lint still passes after removal. Committing unrelated files to fix lint is a scope creep pattern — the right fix is usually deletion."
