---
skill: respond-to-pr-review
issue: 147
pr: 156
round: 3
date: 2026-03-27
fixed_findings: [F10]
---

### F10: vacuous listbox assertion in F6 dropdown-hidden check
**What was caught:** The `queryByRole('listbox')` assertion to verify the dropdown was hidden always returns null — the dropdown is a plain `<div>`, not a listbox — so the assertion never actually proved `showDropdown` was false.
**Why I missed it:** I wrote the assertion without reading the component markup to verify the element's ARIA role. queryByRole() returning null looks like a passing assertion when the element simply has no matching role, not just when it's absent.
**Prompt fix:** Add to testing standards: "Before writing `queryByRole(X).not.toBeInTheDocument()` to assert an element is hidden, confirm the element actually carries that role by reading the component source. For React conditional rendering (`{flag && <div>...</div>}`), assert on text content or element identity visible only when the condition is true, not on ARIA roles that may not be present on the element."
