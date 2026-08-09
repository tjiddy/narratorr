import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// No import/no-cycle rule: keep parser -> patterns -> primitives one-way (#1557).

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
    // A value import from the parser would recreate the cycle.
    const lines = src.split('\n').filter((l) => l.includes("from './folder-parsing.js'"));
    for (const line of lines) {
      expect(line.trimStart()).toMatch(/^import type /);
    }
  });
});
