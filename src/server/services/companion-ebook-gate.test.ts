import { describe, it, expect, vi } from 'vitest';
import {
  isCompanionEbookExposed,
  isCompanionEbookOwnerReadable,
  type CompanionEbookExposureInput,
} from '@shared/companion-ebook-exposure.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';
import { evaluateCompanionEbookGate, type CompanionEbookGateDeps } from './companion-ebook-gate.js';

const BOOK_ID = 42;
const BOOK_PATH = '/library/Author/Title';
const LIBRARY_ROOT = '/library';
const FILENAME = 'book.epub';

interface Overrides {
  enabled?: boolean;
  /** `null` = rung 2 resolves nothing. */
  resolvedId?: number | null;
  /** `null` = rung 3 finds no row. */
  book?: { status: BookStatus; path: string | null } | null;
  /** `null` = no observation row at all. */
  observation?: { status: CompanionEbookStatus; filename: string | null } | null;
  libraryRoot?: string;
  gate?: (input: CompanionEbookExposureInput) => boolean;
}

/**
 * Every rung is an injected double, so each read can be asserted directly — including the
 * ones a route-level suite cannot tell apart (`resolveByPublicId` and `findCompanionEbook`
 * are both `db.select` at the v1 boundary).
 */
function makeDeps(overrides: Overrides = {}) {
  const settingsGet = vi.fn(async (key: string) => {
    if (key === 'companionEpub') return { enabled: overrides.enabled ?? true };
    if (key === 'library') return { path: overrides.libraryRoot ?? LIBRARY_ROOT };
    throw new Error(`unexpected settings category: ${key}`);
  });
  const getById = vi.fn(async () =>
    overrides.book === undefined
      ? { id: BOOK_ID, status: 'imported' as BookStatus, path: BOOK_PATH as string | null }
      : overrides.book,
  );
  const resolveBookId = vi.fn(async () => (overrides.resolvedId === undefined ? BOOK_ID : overrides.resolvedId));
  const findObservation = vi.fn(async () =>
    overrides.observation === undefined
      ? { status: 'available' as CompanionEbookStatus, filename: FILENAME as string | null }
      : overrides.observation,
  );
  const gate = vi.fn(overrides.gate ?? isCompanionEbookOwnerReadable);

  const deps = {
    settingsService: { get: settingsGet },
    bookService: { getById },
    resolveBookId,
    findObservation,
    isExposed: gate,
  } as unknown as CompanionEbookGateDeps;

  return { deps, settingsGet, getById, resolveBookId, findObservation, gate };
}

/** Rung 8 is the ONLY `library` read; every other settings call is rung 1. */
function libraryReads(settingsGet: ReturnType<typeof vi.fn>): number {
  return settingsGet.mock.calls.filter((call) => call[0] === 'library').length;
}

describe('evaluateCompanionEbookGate — the success context', () => {
  it('returns the context the eight rungs produced, bookId included', async () => {
    const { deps } = makeDeps();

    const result = await evaluateCompanionEbookGate(deps);

    // `bookId` is asserted explicitly: it is the value the v1 success tail cannot reconstruct
    // once the helper owns rungs 2-3 (AC2).
    expect(result).toEqual({
      context: { bookId: BOOK_ID, bookPath: BOOK_PATH, filename: FILENAME, libraryRoot: LIBRARY_ROOT },
    });
  });

  it('threads rung 1\'s enabled value into the predicate input', async () => {
    const { deps, gate } = makeDeps();

    await evaluateCompanionEbookGate(deps);

    expect(gate).toHaveBeenCalledWith({ enabled: true, bookStatus: 'imported', observationStatus: 'available' });
  });

  it('issues exactly one read per rung and nothing else', async () => {
    const { deps, settingsGet, getById, resolveBookId, findObservation, gate } = makeDeps();

    await evaluateCompanionEbookGate(deps);

    // The helper's whole observable surface. It takes no logger and no reconciler, so "logs
    // nothing, triggers nothing" is structural; what a double CAN see is that it never issues
    // a read twice or a read it was not asked for (AC9).
    expect(settingsGet.mock.calls).toEqual([['companionEpub'], ['library']]);
    expect(resolveBookId).toHaveBeenCalledTimes(1);
    expect(getById.mock.calls).toEqual([[BOOK_ID]]);
    expect(findObservation.mock.calls).toEqual([[BOOK_ID]]);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('resolves a truthy but non-persistable stored basename to a context, not a rejection', async () => {
    // A padded `' book.epub'` is rejected by `isPersistableCompanionBasename` in the OPENER,
    // which is the single validation authority and carries the `invalid_filename` outcome plus
    // its warn + reconcile side effects (AC10). A trim or basename guard here would silently
    // delete both. This row is the detector.
    const { deps } = makeDeps({ observation: { status: 'available', filename: ' book.epub' } });

    const result = await evaluateCompanionEbookGate(deps);

    expect(result).toEqual({
      context: { bookId: BOOK_ID, bookPath: BOOK_PATH, filename: ' book.epub', libraryRoot: LIBRARY_ROOT },
    });
  });
});

describe('evaluateCompanionEbookGate — one rejection per rung', () => {
  it('rung 1: rejects `disabled` when the feature flag is off', async () => {
    const { deps } = makeDeps({ enabled: false });

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'disabled' });
  });

  it('rung 2: rejects book-shaped when the identity thunk resolves null', async () => {
    const { deps } = makeDeps({ resolvedId: null });

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'no_book' });
  });

  it('rung 3: rejects book-shaped when the book row is gone', async () => {
    const { deps } = makeDeps({ book: null });

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'no_book' });
  });

  it.each([
    ['the book is not imported', { book: { status: 'missing' as BookStatus, path: BOOK_PATH } }],
    ['there is no observation row', { observation: null }],
    ['the observation status is outside the gate\'s set', { observation: { status: 'ambiguous' as CompanionEbookStatus, filename: null } }],
  ])('rung 5: rejects not_exposed when %s', async (_label, overrides) => {
    const { deps } = makeDeps(overrides);

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'not_exposed' });
  });

  // The guard is `!filename`, not a nullish check — `''` must reject too.
  it.each([[null], ['']])('rung 6: rejects no_file for a stored filename of %p', async (filename) => {
    const { deps } = makeDeps({ observation: { status: 'available', filename } });

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'no_file' });
  });

  it.each([[null], [''], ['   ']])('rung 7: rejects no_path for a books.path of %p', async (path) => {
    const { deps } = makeDeps({ book: { status: 'imported', path } });

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'no_path' });
  });
});

describe('evaluateCompanionEbookGate — short-circuiting', () => {
  it('rung 1 short-circuits every later rung — the no-oracle property at the helper', async () => {
    const { deps, settingsGet, getById, resolveBookId, findObservation, gate } = makeDeps({ enabled: false });

    await evaluateCompanionEbookGate(deps);

    expect(settingsGet.mock.calls).toEqual([['companionEpub']]);
    expect(resolveBookId).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
    expect(findObservation).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
  });

  it('rung 2 short-circuits the book row, the observation, the predicate and the library read', async () => {
    const { deps, settingsGet, getById, findObservation, gate } = makeDeps({ resolvedId: null });

    await evaluateCompanionEbookGate(deps);

    expect(getById).not.toHaveBeenCalled();
    expect(findObservation).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(libraryReads(settingsGet)).toBe(0);
  });

  it('rung 3 short-circuits the observation read, the predicate and the library read', async () => {
    // The shipped v1 route row for this case asserts only that `getById` was called, so it
    // stays green if rung 4 is reordered ahead of rung 3 — and at the v1 boundary `db.select`
    // is the shared observable for both reads anyway. This is the detector.
    const { deps, settingsGet, findObservation, gate } = makeDeps({ book: null });

    await evaluateCompanionEbookGate(deps);

    expect(findObservation).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(libraryReads(settingsGet)).toBe(0);
  });

  it.each([
    ['not_exposed', { observation: null }],
    ['no_file', { observation: { status: 'available' as CompanionEbookStatus, filename: '' } }],
    ['no_path', { book: { status: 'imported' as BookStatus, path: '   ' } }],
  ])('the library read is not reachable ahead of the gate — %s', async (_arm, overrides) => {
    const { deps, settingsGet } = makeDeps(overrides);

    await evaluateCompanionEbookGate(deps);

    expect(libraryReads(settingsGet)).toBe(0);
  });
});

describe('evaluateCompanionEbookGate — dependency failures propagate (AC13)', () => {
  const boom = new Error('dependency exploded');

  async function expectPropagated(deps: CompanionEbookGateDeps): Promise<void> {
    // Assert on the REJECTION, never on a returned arm: translating an outage into `no_book`
    // is exactly the false negative this rule exists to prevent.
    await expect(evaluateCompanionEbookGate(deps)).rejects.toThrow('dependency exploded');
  }

  it('rung 1: a rejecting settings.get(companionEpub) escapes', async () => {
    const { deps, settingsGet } = makeDeps();
    settingsGet.mockRejectedValue(boom);

    await expectPropagated(deps);
  });

  it('rung 2: a rejecting identity thunk escapes', async () => {
    const { deps, resolveBookId } = makeDeps();
    resolveBookId.mockRejectedValue(boom);

    await expectPropagated(deps);
  });

  it('rung 3: a rejecting bookService.getById escapes', async () => {
    const { deps, getById } = makeDeps();
    getById.mockRejectedValue(boom);

    await expectPropagated(deps);
  });

  it('rung 4: a rejecting findCompanionEbook escapes', async () => {
    const { deps, findObservation } = makeDeps();
    findObservation.mockRejectedValue(boom);

    await expectPropagated(deps);
  });

  it('rung 8: a rejecting settings.get(library) escapes', async () => {
    const { deps, settingsGet } = makeDeps();
    settingsGet.mockImplementation(async (key: string) => {
      if (key === 'companionEpub') return { enabled: true };
      throw boom;
    });

    await expectPropagated(deps);
  });

  it('a rung-4 fault is unobservable when rung 3 already short-circuited', async () => {
    // Precedence: the shipped ladder answers its book-shaped negative here. Reordering rung 4
    // ahead of rung 3 turns this same request into a 500 — an AC7 violation.
    const { deps, findObservation } = makeDeps({ book: null });
    findObservation.mockRejectedValue(boom);

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'no_book' });
  });
});

describe('evaluateCompanionEbookGate — the gate is a parameter (#2038)', () => {
  const drmFixture = { observation: { status: 'drm_protected' as CompanionEbookStatus, filename: FILENAME } };

  it('admits a stored drm_protected row under the owner gate', async () => {
    const { deps } = makeDeps({ ...drmFixture, gate: isCompanionEbookOwnerReadable });

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({
      context: { bookId: BOOK_ID, bookPath: BOOK_PATH, filename: FILENAME, libraryRoot: LIBRARY_ROOT },
    });
  });

  it('rejects the same row under the advertisement gate', async () => {
    const { deps } = makeDeps({ ...drmFixture, gate: isCompanionEbookExposed });

    await expect(evaluateCompanionEbookGate(deps)).resolves.toEqual({ rejection: 'not_exposed' });
  });
});
