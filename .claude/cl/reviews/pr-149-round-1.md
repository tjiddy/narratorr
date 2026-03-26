---
skill: respond-to-pr-review
issue: 149
pr: 152
round: 1
date: 2026-03-26
fixed_findings: [F1, F2, F3]
---

### F1: DownloadError name contract not asserted
**What was caught:** Tests verified `instanceof DownloadError && e.code === 'NOT_FOUND'` but not `e.name`. Deleting `this.name = 'DownloadError'` would leave all tests green.
**Why I missed it:** Focused on the behavioral properties (`code`) rather than the constructor contract. The `name` field is easy to overlook because `instanceof` already proves the class is correct — `name` feels redundant. But the spec listed it as an explicit requirement and it matters for error serialization/logging.
**Prompt fix:** Add to `/plan` step (and CLAUDE.md under typed error pattern): "When defining a typed error class, add a dedicated constructor contract test asserting `name`, `code`, `message`, and `instanceof Error`. Deleting `this.name` must fail at least one test."

### F2: TaskRegistryError name contract not asserted
**What was caught:** Same gap as F1 — only `instanceof` + `code` were asserted, not `name`.
**Why I missed it:** Same root cause as F1. Applied the same test template to both new error classes without adding the `name` assertion.
**Prompt fix:** Same as F1 — the pattern applies to both new error classes introduced in this PR. The fix is a one-liner rule: "every new typed error class needs a constructor contract test that covers name, code, message, instanceof Error."

### F3: stat() call not verified against post-rename destination path
**What was caught:** The merge sequencing test verified that `db.update().set()` received the correct `size` value, but not that `stat()` was called on the destination path (`join(BOOK_PATH, stagedM4b)`) vs. the staging path. Since both paths return the same mocked size, the test would pass even if a regression moved `stat()` back to the staging path.
**Why I missed it:** Tested the downstream consequence (DB receives correct size) but not the intermediate constraint (stat is called on the right path). The review requirement was: "prove that `stat()` ran on the post-rename destination path." I only proved the output, not the input.
**Prompt fix:** Add to CLAUDE.md or `/plan`: "When testing 'value X comes from function Y with argument Z,' assert both the argument to Y (`expect(Y).toHaveBeenCalledWith(Z)`) and the downstream result. Asserting only the result allows regressions in the source path to go undetected."
