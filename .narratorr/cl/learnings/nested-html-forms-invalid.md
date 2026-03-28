---
scope: [scope/frontend]
files: [apps/narratorr/src/client/components/settings/RemotePathMappingsSubsection.tsx]
issue: 225
date: 2026-02-24
---
Nested HTML `<form>` elements are invalid — browsers silently ignore the inner `<form>` tag, so `type="submit"` buttons inside it submit the outer form instead. React's synthetic events don't fix this. When embedding interactive subsections inside a parent form, use `<div>` + `type="button"` with explicit `onClick` instead of a nested form. The #208 learning about `type="button"` was on the right track but didn't go far enough — the inner form's `onSubmit` with `e.preventDefault()` never fires because the browser doesn't recognize it as a form boundary.
