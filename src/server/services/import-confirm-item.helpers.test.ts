import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '@core/metadata/index.js';
import type { DuplicateCandidate } from './book-dedup.js';
import { BOOK_STATUSES } from '@shared/schemas/book.js';
import { classifyConfirmItem } from './import-confirm-item.helpers.js';
import type { ImportConfirmItem } from './library-scan.service.js';

/** Doubles only the duplicate primitive, so the real decision module runs inside the classifier. */
function setup(resolution: unknown, opts: { reject?: boolean } = {}) {
  const findDuplicate = vi.fn((_candidate: DuplicateCandidate) =>
    opts.reject ? Promise.reject(resolution) : Promise.resolve(resolution),
  );
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  return { bookService: { findDuplicate } as never, findDuplicate, log };
}

function makeItem(overrides: Partial<ImportConfirmItem> = {}): ImportConfirmItem {
  return { path: '/staging/Tehanu', title: 'Tehanu', authorName: 'Ursula K. Le Guin', ...overrides };
}

const ADMIT = { verdict: 'different-recording', book: null, hasIncumbent: false };
const INCUMBENT = { id: 421, title: 'Tehanu (1990 recording)' };

describe('classifyConfirmItem — bypass', () => {
  it('short-circuits forceImport to proceed WITHOUT any duplicate query', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);

    const out = await classifyConfirmItem(makeItem({ forceImport: true }), bookService, log);

    expect(out).toBe('proceed');
    // The decision module always queries, so the bypass is only observable as a missing call.
    expect(findDuplicate).not.toHaveBeenCalled();
  });
});

describe('classifyConfirmItem — classification', () => {
  it('skips a same-recording and names the incumbent id and title', async () => {
    const { bookService, log } = setup({ verdict: 'same-recording', book: INCUMBENT, hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    // A pathless incumbent holds no file, so there is no other path to name.
    expect(out).toEqual({ skip: true, reason: 'already-in-library', existingBookId: 421, existingTitle: 'Tehanu (1990 recording)' });
  });

  it('skips a same-recording with a NULL incumbent carrying neither key', async () => {
    const { bookService, log } = setup({ verdict: 'same-recording', book: null, hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    expect(out).toEqual({ skip: true, reason: 'already-in-library' });
    expect(out).not.toHaveProperty('existingBookId');
    expect(out).not.toHaveProperty('existingTitle');
    expect(out).not.toHaveProperty('existingPath');
  });

  it('holds a review verdict as a recording-review-required item', async () => {
    const { bookService, log } = setup({ verdict: 'review', book: INCUMBENT, hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    expect(out).toEqual({
      path: '/staging/Tehanu',
      title: 'Tehanu',
      reason: 'recording-review-required',
      existingBookId: 421,
    });
  });

  it('holds a review with a null incumbent without an existingBookId key', async () => {
    const { bookService, log } = setup({ verdict: 'review', book: null, hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    expect(out).toEqual({ path: '/staging/Tehanu', title: 'Tehanu', reason: 'recording-review-required' });
    expect(out).not.toHaveProperty('existingBookId');
  });

  it('proceeds on a different recording of an owned title', async () => {
    const { bookService, log } = setup({ verdict: 'different-recording', book: null, hasIncumbent: true });

    expect(await classifyConfirmItem(makeItem(), bookService, log)).toBe('proceed');
  });
});

/**
 * #2435 AC4: a `same-recording` incumbent that holds no file is the record this file should fulfil.
 * The status matrix is the same one the book-scoped route applies at its own entry point.
 */
describe('classifyConfirmItem — attach classification', () => {
  const fileless = (overrides: Record<string, unknown> = {}) =>
    ({ id: 421, title: 'Tehanu (1990 recording)', path: null, status: 'wanted', ...overrides });

  it.each(BOOK_STATUSES)('classifies a fileless %s incumbent', async (status) => {
    const { bookService, log } = setup({ verdict: 'same-recording', book: fileless({ status }), hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    if (['wanted', 'searching', 'failed', 'missing'].includes(status)) {
      expect(out).toEqual({ attach: true, bookId: 421, title: 'Tehanu (1990 recording)', status });
    } else {
      // downloading/importing are owned by a live acquisition; imported is already fulfilled.
      // The incumbent holds no file, so #2091 has no path to snapshot and the generic reason stands.
      expect(out).toEqual({ skip: true, reason: 'already-in-library', existingBookId: 421, existingTitle: 'Tehanu (1990 recording)' });
    }
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('treats a %s path as fileless and attaches', async (_label, path) => {
    const { bookService, log } = setup({ verdict: 'same-recording', book: fileless({ path }), hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    expect(out).toEqual({ attach: true, bookId: 421, title: 'Tehanu (1990 recording)', status: 'wanted' });
  });

  it('still skips an incumbent that holds a file', async () => {
    const { bookService, log } = setup({
      verdict: 'same-recording', book: fileless({ path: '/library/A/B' }), hasIncumbent: true,
    });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    expect(out).toEqual({
      skip: true, reason: 'duplicate-copy-at-other-path',
      existingBookId: 421, existingTitle: 'Tehanu (1990 recording)', existingPath: '/library/A/B',
    });
  });

  it('logs the attach at info and emits no debug skip line', async () => {
    const { bookService, log } = setup({ verdict: 'same-recording', book: fileless(), hasIncumbent: true });

    await classifyConfirmItem(makeItem(), bookService, log);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ existingBookId: 421, title: 'Tehanu' }),
      expect.stringContaining('Attaching'),
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('keeps the owned-duplicate skip on debug', async () => {
    const { bookService, log } = setup({
      verdict: 'same-recording', book: fileless({ path: '/library/A/B' }), hasIncumbent: true,
    });

    await classifyConfirmItem(makeItem(), bookService, log);

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ existingBookId: 421 }),
      expect.stringContaining('Skipping owned duplicate'),
    );
  });

  it('does not attach when forceImport bypasses the decision entirely', async () => {
    const { bookService, findDuplicate, log } = setup({ verdict: 'same-recording', book: fileless(), hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem({ forceImport: true }), bookService, log);

    expect(out).toBe('proceed');
    expect(findDuplicate).not.toHaveBeenCalled();
  });
});

/**
 * #2091 AC13/14 — a same-recording skip splits on WHERE the incumbent's file is. Path identity
 * goes through `canonicalPath`, so drifted spellings of one folder must not read as two copies.
 */
describe('classifyConfirmItem — copy-at-other-path skip reason (#2091)', () => {
  const owner = (path: string | null) =>
    ({ id: 421, title: 'Tehanu (1990 recording)', path, status: 'imported' });

  it('reports a genuinely different incumbent folder as a copy at another path', async () => {
    const { bookService, log } = setup({
      verdict: 'same-recording', book: owner('/library/Le Guin/Earthsea/Tehanu'), hasIncumbent: true,
    });

    const out = await classifyConfirmItem(makeItem({ path: '/library/Le Guin/Tehanu' }), bookService, log);

    expect(out).toEqual({
      skip: true,
      reason: 'duplicate-copy-at-other-path',
      existingBookId: 421,
      existingTitle: 'Tehanu (1990 recording)',
      existingPath: '/library/Le Guin/Earthsea/Tehanu',
    });
  });

  it('reports an incumbent sitting at the item path as already-in-library, with no path', async () => {
    const { bookService, log } = setup({
      verdict: 'same-recording', book: owner('/library/Le Guin/Tehanu'), hasIncumbent: true,
    });

    const out = await classifyConfirmItem(makeItem({ path: '/library/Le Guin/Tehanu' }), bookService, log);

    expect(out).toEqual({
      skip: true, reason: 'already-in-library', existingBookId: 421, existingTitle: 'Tehanu (1990 recording)',
    });
    expect(out).not.toHaveProperty('existingPath');
  });

  // Each of these names the SAME folder as the item path; a raw string compare would invent a copy.
  it.each([
    ['a trailing slash', '/library/Le Guin/Tehanu/'],
    ['a redundant dot segment', '/library/Le Guin/./Tehanu'],
    ['a parent-then-descend detour', '/library/Le Guin/Earthsea/../Tehanu'],
    ['backslash separators', '\\library\\Le Guin\\Tehanu'],
    ['a doubled separator', '/library/Le Guin//Tehanu'],
  ])('normalizes %s to the same folder and stays already-in-library', async (_label, incumbentPath) => {
    const { bookService, log } = setup({ verdict: 'same-recording', book: owner(incumbentPath), hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem({ path: '/library/Le Guin/Tehanu' }), bookService, log);

    expect(out).toMatchObject({ skip: true, reason: 'already-in-library' });
    expect(out).not.toHaveProperty('existingPath');
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('never fabricates a path from a %s incumbent path in a non-attachable status', async (_label, path) => {
    const { bookService, log } = setup({
      verdict: 'same-recording', book: { ...owner(path), status: 'imported' }, hasIncumbent: true,
    });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    expect(out).toMatchObject({ skip: true, reason: 'already-in-library' });
    expect(out).not.toHaveProperty('existingPath');
  });
});

describe('classifyConfirmItem — candidate construction', () => {
  it('prefers item.asin over item.metadata.asin', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);
    const metadata = { asin: 'FROM_METADATA' } as unknown as BookMetadata;

    await classifyConfirmItem(makeItem({ asin: 'FROM_ITEM', metadata }), bookService, log);

    expect(findDuplicate.mock.calls[0]![0]).toMatchObject({ asin: 'FROM_ITEM' });
  });

  it('falls back to item.metadata.asin when the item carries none', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);
    const metadata = { asin: 'FROM_METADATA' } as unknown as BookMetadata;

    await classifyConfirmItem(makeItem({ metadata }), bookService, log);

    expect(findDuplicate.mock.calls[0]![0]).toMatchObject({ asin: 'FROM_METADATA' });
  });

  it('carries no asin key when neither source supplies one', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);

    await classifyConfirmItem(makeItem(), bookService, log);

    expect(findDuplicate.mock.calls[0]![0]).not.toHaveProperty('asin');
  });

  // Two positive durations short-circuit before the production-form check, so productionType is
  // carried for the duration-undecidable case only — it is not a veto over a decided pair.
  it('normalizes metadata.formatType into productionType', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);
    const metadata = { formatType: 'Abridged' } as unknown as BookMetadata;

    await classifyConfirmItem(makeItem({ metadata }), bookService, log);

    expect(findDuplicate.mock.calls[0]![0]).toMatchObject({ productionType: 'abridged' });
  });

  it('leaves productionType off the candidate when formatType is absent', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);
    const metadata = { duration: 600 } as unknown as BookMetadata;

    await classifyConfirmItem(makeItem({ metadata }), bookService, log);

    const candidate = findDuplicate.mock.calls[0]![0];
    expect(candidate).not.toHaveProperty('productionType');
    expect(candidate).toMatchObject({ duration: 600 });
  });

  it('builds a title+authors-only candidate when metadata is entirely absent', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);

    await classifyConfirmItem(makeItem(), bookService, log);

    expect(findDuplicate.mock.calls[0]![0]).toEqual({
      title: 'Tehanu',
      authors: [{ name: 'Ursula K. Le Guin' }],
    });
  });

  it('passes narrators through when the item supplies them', async () => {
    const { bookService, findDuplicate, log } = setup(ADMIT);

    await classifyConfirmItem(makeItem({ narrators: ['Jenny Sterlin'] }), bookService, log);

    expect(findDuplicate.mock.calls[0]![0]).toMatchObject({ narrators: ['Jenny Sterlin'] });
  });
});

describe('classifyConfirmItem — failure policy', () => {
  // No local try/catch: the throw must reach the runner boundary that writes a terminal failed row.
  it('propagates a rejecting decision instead of classifying', async () => {
    const boom = new Error('DB connection lost');
    const { bookService, log } = setup(boom, { reject: true });

    const settled = await Promise.allSettled([classifyConfirmItem(makeItem(), bookService, log)]);

    expect(settled[0]!.status).toBe('rejected');
    expect((settled[0] as PromiseRejectedResult).reason).toBe(boom);
  });
});
