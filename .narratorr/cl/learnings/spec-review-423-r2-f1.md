---
scope: [scope/backend]
files: []
issue: 423
source: spec-review
date: 2026-03-17
---
Reviewer caught that `/index.html` (root, empty urlBase) was missing from the direct static entry route test matrix even though the scope said "all HTML-serving paths." The first round added `/<urlBase>/` and `/<urlBase>/index.html` but only added `/` for empty urlBase, not `/index.html`. The gap was caused by not systematically enumerating the cross-product of {with urlBase, without urlBase} × {trailing slash, `/index.html`}. When listing route variants, enumerate the full cross-product rather than listing examples.
