---
skill: respond-to-pr-review
issue: 30
pr: 33
round: 1
date: 2026-03-20
fixed_findings: [F1, F2]
---

### F1: Underscore word-boundary bug in ebook format regex
**What was caught:** `\b` doesn't match at `_`/letter boundaries in JS because `_` is part of `\w`. Scene-style release names like `Dune_EPUB` slipped through.
**Why I missed it:** I tested dot/space/hyphen separators but not underscores. The explore agent mentioned parse.ts normalizes underscores, but I didn't connect that to the need for underscore-safe regex in my own filter.
**Prompt fix:** Add to `/implement` step 4 or CLAUDE.md Gotchas: "When writing title-keyword regex, always test all common release-name separators: space, dot, hyphen, AND underscore. JavaScript `\b` does not treat `_` as a word boundary — use `(?<![a-zA-Z\d])` / `(?![a-zA-Z\d])` instead."

### F2: Incomplete test coverage for audio keyword alternation
**What was caught:** FLAC and OGG were in the production regex but had no direct test assertions. Removing either wouldn't fail the test suite.
**Why I missed it:** I tested a sampling (M4B, MP3, AAC) rather than every variant. The spec said "M4B, MP3, FLAC, AAC, OGG" — I should have mechanically mapped each to a test case.
**Prompt fix:** Add to test quality standards: "When a regex or condition uses a fixed alternation (A|B|C|D|E), write one test assertion per alternative. A partial sampling can't prevent individual-variant regression."
