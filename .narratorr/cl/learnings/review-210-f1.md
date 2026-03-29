---
scope: [core]
files: [src/core/utils/naming-presets.ts]
issue: 210
source: review
date: 2026-03-29
---
Preset folder format strings used `{series/}` syntax that the template renderer doesn't support. The renderer recognizes `{token}`, `{token:00}`, and `{token?text}` — the `{series/}` shorthand (slash as implicit conditional separator) was invented syntax. Correct form is `{series?/}` which uses the conditional suffix feature. We missed this because preset tests only verified the string values matched, not that the strings were valid template syntax. Fix: added a preset validity test that renders all preset templates and asserts no literal brace artifacts remain.
