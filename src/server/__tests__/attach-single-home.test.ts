import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #2435 AC1 — the ownership question and the attachable-status matrix each have exactly one home.
 *
 * A structural guard, deliberately: without it AC1's invariant is a comment rather than a contract,
 * and the failure mode it prevents is silent — a second site spelling the predicate slightly
 * differently (a bare `!path`, or its own `.trim()`) disagrees only on whitespace, which is exactly
 * the value no functional test tends to carry.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Every site this issue added that asks "does this book hold a file?" or "is it attachable?". */
const ATTACH_DECISION_SITES = [
  'src/server/services/book-intake/decide-intake.ts',
  'src/server/services/library-scan.service.ts',
  'src/server/services/import-confirm-item.helpers.ts',
  'src/server/routes/book-import-files.ts',
  'src/client/pages/book/BookDetails.tsx',
];

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');

describe('the attach predicates have a single home', () => {
  it.each(ATTACH_DECISION_SITES)('%s reaches the decision through the shared module', (rel) => {
    const source = read(rel);
    expect(source).toMatch(/@shared\/(book-holds-file|attach-eligibility)\.js/);
  });

  // `.trim()` against a path is how the second, divergent predicate always starts.
  it.each(ATTACH_DECISION_SITES)('%s does not roll its own path trim', (rel) => {
    const source = read(rel);
    expect(source).not.toMatch(/\.path[!?]*\s*\)?\s*\.\s*trim\s*\(/);
  });

  // The status matrix is the other half: AC4 and AC16 must ask the same question, or the UI offers
  // an action the server refuses.
  it.each(ATTACH_DECISION_SITES)('%s does not inline the attachable-status list', (rel) => {
    const source = read(rel);
    expect(source).not.toMatch(/['"]wanted['"]\s*,\s*['"]searching['"]/);
  });

  it('defines the attachable-status list exactly once, in the shared module', () => {
    const shared = read('src/shared/attach-eligibility.ts');
    expect(shared).toContain("ATTACHABLE_BOOK_STATUSES = ['wanted', 'searching', 'failed', 'missing']");
  });
});

describe('cross-surface agreement on one whitespace-only path', () => {
  it('every attach surface treats a whitespace path as fileless', async () => {
    const { bookHoldsFile } = await import('@shared/book-holds-file.js');
    const { canAttachFile } = await import('@shared/attach-eligibility.js');

    // This is the value a bare `!path` and a trimming check disagree about, and the assertion that
    // would have caught two-predicate drift. The per-surface cases live in each surface's suite:
    // decide-intake.test.ts, library-scan.service.test.ts, book-import-files.test.ts and
    // BookDetails.test.tsx each drive '   ' through their own gate.
    expect(bookHoldsFile('   ')).toBe(false);
    expect(canAttachFile({ path: '   ', status: 'wanted' })).toBe(true);
  });
});
