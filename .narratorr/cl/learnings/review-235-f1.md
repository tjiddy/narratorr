---
scope: [backend, core]
files: [src/server/services/library-scan.service.ts]
issue: 235
source: review
date: 2026-03-31
---
`extractYear()` needs the same normalization pipeline as `cleanName()` — at minimum underscore/dot conversion AND codec tag stripping — before scanning for year patterns. The motivating folder name `__2017__MP3` has the year buried between codec tags, so without stripping them first, the bare year regex sees `2017 MP3` (year not at end) and returns undefined. Missed because `extractYear()` was written as a simpler version of `cleanName()` without considering that codec tags can trail the year.
