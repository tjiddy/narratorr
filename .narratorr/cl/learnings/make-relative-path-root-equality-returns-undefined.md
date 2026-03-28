---
scope: [frontend]
files: [src/client/pages/manual-import/pathUtils.ts, src/client/components/manual-import/ImportCard.tsx]
issue: 175
date: 2026-03-28
---
When implementing makeRelativePath, return undefined (not empty string) when absolutePath exactly equals libraryPath. ImportCard uses nullish coalescing: relativePath ?? pathParts.slice(-3).join("/") — an empty string wins the coalesce and renders a blank path line. undefined correctly falls through to the 3-part short-path fallback. The strictly-inside check (pathSegments.length <= rootSegments.length returns undefined) handles both exact-equality and parent-path cases in one condition.
