---
skill: respond-to-pr-review
issue: 161
pr: 172
round: 1
date: 2026-03-28
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1-F2: ConfirmModal and SearchReleasesModal missing Escape tests
**What was caught:** Both components use useEscapeKey but their tests had no {Escape} keyboard interaction test after the shell refactor.
**Why I missed it:** The coverage review checklist enumerated "backdrop click" and "X button" as close behaviors, but useEscapeKey is a third close path that wasn't in the explicit checklist. The coverage subagent also didn't flag it.
**Prompt fix:** Add to the coverage review prompt: "For any component that imports useEscapeKey, verify there is a test that calls userEvent.keyboard('{Escape}') and asserts the close callback fires."

### F3-F5-F7: Missing type="button" on inner component buttons
**What was caught:** Grab, Blacklist, UnsupportedSection toggle, search result selection, Cancel, Save buttons were missing type="button" in 3 files.
**Why I missed it:** During implementation I only added type="button" to buttons that were directly visible in the AC text ("close button", "refresh button", "back button"). Did not do a comprehensive grep for all <button> tags in migrated files.
**Prompt fix:** Add to CLAUDE.md or the implementation skill: "When an issue mentions type=button, after making changes, grep for '<button' without 'type=' in all changed files and add type=\"button\" to every instance. This is a completeness check, not a selective fix."

### F4-F6: BookMetadataModal and BookEditModal mocked useEscapeKey, making Escape untestable
**What was caught:** vi.mock('@/hooks/useEscapeKey') in both test files meant pressing Escape did nothing in tests — the real hook wasn't running.
**Why I missed it:** The mocks were pre-existing and seemed innocuous (just vi.fn()). Didn't realize they prevented the real hook from registering an event listener.
**Prompt fix:** Add to testing standards: "Never mock useEscapeKey — it attaches to document.addEventListener which testing-library's userEvent can trigger. Mock it only if you have a specific reason. If it's already mocked and you need an Escape test, remove the mock."
