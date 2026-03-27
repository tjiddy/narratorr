---
scope: [scope/frontend]
files: [src/client/components/settings/DownloadClientFields.tsx, src/client/components/settings/DownloadClientFields.test.tsx]
issue: 147
source: review
date: 2026-03-27
---
The reviewer caught that the F6 fix asserted `queryByRole('listbox')` to verify the dropdown was hidden, but the dropdown markup is an unstyled <div> — not a listbox — so the assertion always returns null regardless of showDropdown state. The dropdown-hidden half of the F6 contract was still unproven.

Why we missed it: When writing the test, the "dropdown is hidden" assertion was chosen without reading the actual component markup to confirm the element had a semantic ARIA role. queryByRole() silently returns null for elements without a matching role, making the assertion vacuously true.

What would have prevented it: Before writing a queryByRole() assertion to verify absence, confirm the element actually has that role by checking the component source first. For conditional visibility via React state (showDropdown && <div>...), assert on content rendered inside the conditional block (e.g., text that only appears when visible) rather than on ARIA roles that may not be present.
