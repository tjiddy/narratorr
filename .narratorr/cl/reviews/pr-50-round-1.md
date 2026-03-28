---
skill: respond-to-pr-review
issue: 50
pr: 52
round: 1
date: 2026-03-21
fixed_findings: [F1, F2, F3, F4]
---

### F1: registration.onChange not updating RHF field on Browse selection
**What was caught:** Browse selection only called onChange (parent setValue) and never registration.onChange, so RHF-only callers (no separate onChange) would get no Browse updates.
**Why I missed it:** The original synthetic event approach `{ target: { value: path } }` was tried and appeared to not work, so it was replaced with onChange+setValue. But the root cause was missed: RHF reads `event.target.name` FIRST (before getEventValue) to look up the field — missing `name` caused silent no-op. The fix (add name to synthetic event) was never tried.
**Prompt fix:** Add to CLAUDE.md gotchas: "RHF register().onChange reads event.target.name first to look up the field. Synthetic events must include `target.name: registration.name` — without it, `_fields[undefined]` returns undefined and the update silently fails."

### F2: type="button" fix lacks form-context test
**What was caught:** Adding type="button" to DirectoryBrowserModal was untested in the form context that motivated it. A regression removing type="button" would not be caught.
**Why I missed it:** Self-review checklist during handoff focuses on "is behavior tested" but didn't specifically prompt "does this defensive fix have a test proving the problem it prevents?" The fix was considered incidental to the main behavior tests.
**Prompt fix:** Add to handoff self-review: "For any type='button' addition, verify there is a test that opens the component inside a <form> and asserts the form's submit handler is NOT called when the button is clicked."

### F3: Label htmlFor broken after extraction
**What was caught:** LibrarySettingsSection had `htmlFor="libraryPath"` on the <label> but PathInput didn't accept/forward an id prop, breaking label-input association.
**Why I missed it:** Exploration phase read the JSX but focused on the input wiring, not the label. The htmlFor was in a sibling element not directly adjacent to the PathInput call.
**Prompt fix:** Add to /plan component extraction checklist: "Check the call site for htmlFor on any <label> adjacent to the element being extracted. If found, the new component needs an id prop forwarded to the inner input."

### F4: Negative error assertion can't catch a broken implementation
**What was caught:** queryByRole('alert') always returns null (PathInput uses <p>, not role=alert), so the test passed even if error text was always showing.
**Why I missed it:** Used a common ARIA pattern (role=alert for errors) without verifying the component actually renders that role. Should always check the component source to see what role/element is used for error display.
**Prompt fix:** Add to test quality checklist: "For negative assertions ('error is NOT shown'), verify the element selector actually selects what the component renders when the error IS shown — test the selector on the positive case first."
