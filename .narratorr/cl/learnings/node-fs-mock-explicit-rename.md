---
name: node-fs-mock-explicit-rename
description: When mocking node:fs/promises with importOriginal spread, explicitly override every function used — spread gives real implementations that throw in tests
type: feedback
scope: [backend, services]
files: [src/server/services/bulk-operation.service.test.ts]
issue: 135
date: 2026-03-26
---

When mocking `node:fs/promises` with `async (importOriginal) => { const actual = await importOriginal(); return { ...actual, cp: vi.fn(), mkdir: vi.fn() } }`, you get real implementations for any function not explicitly overridden. Real fs functions throw (ENOENT, etc.) when test paths don't exist.

**Fix:** Explicitly include every fs function the code under test calls:
```ts
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    cp: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),  // must be explicit — spread gives real rename that throws ENOENT
    rm: vi.fn(),
    readdir: vi.fn(),
    unlink: vi.fn(),
  };
});
```

**Why:** The bug manifested as `rename` calls throwing ENOENT even though `cp` and other mocks were working. The `rename` function wasn't in the mock override list, so `...actual` provided the real `node:fs/promises.rename`, which threw because the staging path doesn't exist in tests.

**How to apply:** Before shipping fs mocks, grep the production code for all `import { ... } from 'node:fs/promises'` calls and ensure every imported function is explicitly mocked.
