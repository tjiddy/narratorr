---
scope: [frontend, testing]
files: [src/client/pages/book/BookDetails.test.tsx]
issue: 657
date: 2026-04-20
---
When appending tests to a large existing test file, don't trust the last `});` as the outer-describe closer. `BookDetails.test.tsx` contains multiple top-level sibling `describe` blocks (`describe('BookDetails', ...)` ends at line 1259, then `describe('#257 merge observability — BookDetails progress', ...)` at line 1265). My append-before-EOF landed inside `#257 merge observability`, which inherits neither the `vi.clearAllMocks()` `beforeEach` nor the `mockNavigate.mockClear()` setup — so mocks polluted across tests until I added a local `beforeEach`. Before appending, grep the file for sibling top-level describes (`^describe` at column 0) and anchor your edit against an explicit unique line inside the intended describe, not against the file's final `});`.
