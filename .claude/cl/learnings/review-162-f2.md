---
scope: [scope/frontend, scope/ui]
files: [src/client/components/TestButton.tsx, src/client/components/TestButton.test.tsx]
issue: 162
source: review
date: 2026-03-28
---
When a wrapper component maps one prop to another (e.g., variant to size), tests must assert the output property, not just the input behavior. TestButton maps variant=inline to size sm and variant=form to size md. Only testing click/disabled behavior leaves the variant-to-size mapping completely untested — a refactor could break it silently.
