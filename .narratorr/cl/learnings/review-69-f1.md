---
scope: [scope/frontend]
files: [src/client/components/layout/Layout.test.tsx, src/client/components/layout/Layout.tsx]
issue: 69
source: review
date: 2026-03-24
---
When a component swaps one icon for another (e.g., SearchIcon → PlusIcon), the label change gets tested but the icon change does not. Label assertions do not prove the icon changed because label and icon are independent elements in the nav link.

Why we missed it: The test plan said "update tests to reflect new label and structural changes" but only the label assertion was written. The icon is a silent visual change — there's no obvious textual assertion for it — so it was left without a test.

What would have prevented it: During implementation, for every AC item that includes a non-textual UI change (icon swap, color change, layout restructure), explicitly ask "can the old value silently reappear while the test still passes?" If yes, add a structural assertion. For SVG icons: find the nav link by its label, assert the icon-specific SVG path data is present (PlusIcon: d="M5 12h14") and the old icon's distinctive element is absent (SearchIcon: <circle>).
