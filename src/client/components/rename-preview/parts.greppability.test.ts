import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * AC #2 (#1406): the rename-preview building blocks must have exactly one
 * definition each after extraction — both `RenamePreviewModal` and the new
 * `BulkRenameModal` compose from the shared module rather than re-declaring them.
 *
 * (Note: `RetagPreviewModal` has its own unrelated `DiffRow` for retag-plan
 * diffs — a distinct component with a different signature — so this test asserts
 * the invariant on the rename-preview surface specifically: defined once in the
 * shared module, never redefined in either rename modal.)
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PARTS = join(HERE, 'parts.tsx');
const CONSUMERS = [
  join(HERE, '..', 'RenamePreviewModal.tsx'),
  join(HERE, '..', 'library', 'BulkRenameModal.tsx'),
];
const SHARED_PARTS = ['DiffRow', 'FolderMoveSection', 'FileRenamesSection', 'PreviewBanner', 'ConflictBanner'];

function countDefs(file: string, name: string): number {
  const src = readFileSync(file, 'utf8');
  return (src.match(new RegExp(`function\\s+${name}\\b`, 'g')) ?? []).length;
}

describe('rename-preview parts greppability (AC #2)', () => {
  for (const name of SHARED_PARTS) {
    it(`${name} is defined exactly once in the shared module`, () => {
      expect(countDefs(PARTS, name)).toBe(1);
    });

    it(`${name} is not redefined in either rename modal`, () => {
      for (const consumer of CONSUMERS) {
        expect(countDefs(consumer, name), `redefined in ${consumer}`).toBe(0);
      }
    });
  }
});
