---
skill: respond-to-spec-review
issue: 423
round: 3
date: 2026-03-17
fixed_findings: [F1, F2]
---

### F1: Missing `/index.html` root entry route from AC2

**What was caught:** AC2 covered `/`, `/<urlBase>/`, and `/<urlBase>/index.html` but omitted `/index.html` when urlBase is empty.
**Why I missed it:** Incomplete enumeration — added the three most obvious variants without doing the systematic cross-product of {empty urlBase, non-empty urlBase} × {trailing-slash, /index.html}.
**Prompt fix:** Add to `/spec` test plan checklist: "When listing route/path variants, enumerate the full cross-product of variable dimensions (e.g., {with prefix, without prefix} × {each path form}) rather than listing examples ad hoc."

### F2: `getByLabelText` resolves implicit labels too

**What was caught:** The AC3 test assertion using `getByLabelText(/enabled/i)` would pass both before and after adding explicit `htmlFor`/`id`, because Testing Library resolves implicit wrapped labels.
**Why I missed it:** Assumed `getByLabelText` only matched explicit associations. Didn't verify the assertion would fail on the current code before proposing it.
**Prompt fix:** Add to `/spec` test plan guidance: "For DOM-structure assertions (htmlFor, aria attributes, id), verify the proposed assertion would actually fail on the current code. Behavioral queries (getByLabelText, getByRole) may resolve through multiple mechanisms and mask the specific structural change being tested."
