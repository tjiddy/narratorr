---
scope: [scope/frontend]
files: [src/client/pages/manual-import/PathStep.tsx]
issue: 81
source: review
date: 2026-03-25
---
The spec said sections should render in loading/empty states, but implementation conditionally hid both section shells with `list.length > 0` guards. The approved AC read "sections render without content" but the code returned null for both sections when their lists were empty.

Why missed: Empty state wording in the spec ("renders without content") was interpreted as "don't show anything" rather than "show the section header with a placeholder". The issue spec was clear that sections must always be visible — this was a reading error during implementation.

What would have prevented it: During red/green, writing a test first for the empty-state render condition (e.g., "shows 'No favorite folders yet' when favorites is empty") would have caught this immediately before any production code was written.
