---
scope: [core]
files: [src/core/indexers/myanonamouse.test.ts]
issue: 668
date: 2026-04-22
---
A unit test proving a normalization function returns the right value is not the same as proving the downstream predicate that consumes the value now works. For bugs whose symptom is "value passed through wrong upstream, then got dropped at a filter", the regression test must chain both layers in a single assertion — parse the raw wire shape through the adapter, then run the same filter predicate the pipeline uses — so a future break at either layer is caught. Testing only the unit endpoint (`normalizeLanguage('1') === 'english'`) leaves the filter interaction uncovered: a regression in `filterByLanguage` or a mis-wiring in the pipeline would still let the unit test pass.
