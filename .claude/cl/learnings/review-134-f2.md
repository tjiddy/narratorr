---
scope: [frontend]
files: [src/client/pages/manual-import/pathUtils.test.ts]
issue: 134
source: review
date: 2026-03-26
---
Path utility tests should always include `..` traversal cases as a first-class test group alongside prefix-collision and trailing-slash cases. The initial test suite covered the obvious cases (direct subdirs, prefix false-positives, trailing slashes, empty strings) but missed `..` normalization entirely — because the implementation also didn't handle it, the tests were consistent with the implementation but both were wrong. Whenever writing path ancestor/containment tests, include: paths that traverse up and land outside, paths that traverse up and land inside, single-dot segments, and `..` in the root path itself.
