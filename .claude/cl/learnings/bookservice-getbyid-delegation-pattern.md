---
scope: [backend, services]
files: [src/server/services/tagging.service.ts, src/server/services/import.service.ts, src/server/services/recycling-bin.service.ts]
issue: 79
date: 2026-03-24
---
When consolidating services that previously had their own junction table queries, the pattern is: add `private bookService?: BookService` as optional constructor param, use `this.bookService!.getById()` in the method, update routes/index.ts wiring, and update test constructors to pass a `mockBookService`. The optional injection (`?`) preserves backward compatibility in unit tests while production always injects via DI.
