---
scope: [frontend]
files: [src/client/components/settings/PathMappingEditor.tsx, src/client/components/settings/RemotePathMappingsSubsection.tsx]
issue: 583
date: 2026-04-15
---
Testing `no-hover:` Tailwind classes requires asserting on `className` string contents (e.g., `toContain('no-hover:opacity-100')`) rather than Testing Library's `toHaveClass()`, because `no-hover:` is a custom variant with a colon that doesn't map to a real CSS class name in JSDOM. The same approach is used in BookHero.test.tsx and LibraryBookCard.test.tsx as prior art.
