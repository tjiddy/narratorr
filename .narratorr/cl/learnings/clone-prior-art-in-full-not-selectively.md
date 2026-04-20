---
scope: [frontend, process]
files: [src/client/pages/book/BookLocationSection.tsx, src/client/pages/settings/SecuritySettings.tsx]
issue: 657
date: 2026-04-20
---
When a spec says "mirror `X:N-M` exactly", clone the full line range — don't filter out lines you judge "cosmetic". My first pass cloned the `handleCopy` try/catch body from `SecuritySettings.handleCopy` (198-219) but dropped the adjacent `setCopied(true); setTimeout(() => setCopied(false), 2000);` (lines 214-215) and the `{copied && <span className="sr-only">Copied!</span>}` in the button JSX (line 237) as non-behavioral. A frontend-design review caught it: those lines provide a screen-reader "Copied!" announcement — real a11y value, not cosmetic. Rule: cite-range fidelity is a spec contract; deviate only with an explicit disposition in the PR body.
