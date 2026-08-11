import { describe, it, expect, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '@core/metadata/index.js';
import type { DuplicateCandidate } from './book-dedup.js';
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

    expect(out).toEqual({ skip: true, existingBookId: 421, existingTitle: 'Tehanu (1990 recording)' });
  });

  it('skips a same-recording with a NULL incumbent carrying neither key', async () => {
    const { bookService, log } = setup({ verdict: 'same-recording', book: null, hasIncumbent: true });

    const out = await classifyConfirmItem(makeItem(), bookService, log);

    expect(out).toEqual({ skip: true });
    expect(out).not.toHaveProperty('existingBookId');
    expect(out).not.toHaveProperty('existingTitle');
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
