---
scope: [frontend]
files: [src/client/components/WelcomeModal.test.tsx]
issue: 169
date: 2026-03-28
---
`getByRole('link', { name: /library path/i })` matched multiple elements because Testing Library's accessible name computation includes ALL text content of the `<a>` element (title + description). Use specific patterns (e.g., `/Library path:/i` with the colon) to disambiguate. When writing link-name queries for cards with similar titles, include enough distinctive text to be unambiguous.
