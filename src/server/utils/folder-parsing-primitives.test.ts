import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Structural guard for issue #1557: the folder-parsing modules form a one-way
// dependency graph. The repo has no `import/no-cycle` lint rule, so these
// assertions are what keep the value-cycle from silently coming back.
//   folder-parsing.ts ─▶ folder-parsing-patterns.ts ─▶ folder-parsing-primitives.ts
//   folder-parsing.ts ───────────────────────────────▶ folder-parsing-primitives.ts

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
}

describe('folder-parsing module dependency graph', () => {
  it('primitives is a leaf — imports neither sibling', () => {
    const src = source('./folder-parsing-primitives.ts');
    expect(src).not.toMatch(/from '\.\/folder-parsing\.js'/);
    expect(src).not.toMatch(/from '\.\/folder-parsing-patterns\.js'/);
  });

  it('patterns has no runtime import from folder-parsing.ts (type-only is allowed)', () => {
    const src = source('./folder-parsing-patterns.ts');
    // Every import referencing the parser module must be `import type` — a
    // runtime `import { … } from './folder-parsing.js'` would re-create the cycle.
    const lines = src.split('\n').filter((l) => l.includes("from './folder-parsing.js'"));
    for (const line of lines) {
      expect(line.trimStart()).toMatch(/^import type /);
    }
  });
});
