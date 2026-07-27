import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Stats } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { validateEpub } from '../../core/epub/validate.js';
import { observeCompanionEbook } from './companion-ebook-observe.js';
import type { CompanionEbookRow } from './types.js';

/**
 * Mocked at the OS boundary and at the `core/epub` module boundary, exactly as #1959's test
 * plan fixes it — no `__internal` seam is added to production code to make this reachable
 * (esm-same-module-vi-mock-bypass). `readdir`/`lstat` are the only `node:fs/promises` members
 * anywhere in this module's import graph (`companion-ebook-observe.ts` +
 * `companion-ebook-discovery.ts`), so the factory can be exact rather than a spread of the
 * real module.
 *
 * Discovery runs for REAL against those two spies. That is deliberate: `gone` and
 * `undetermined` are `readdir` errnos, the candidate ordering is discovery's comparator, and
 * a mocked discovery would assert this module against a fiction of its collaborator.
 */
vi.mock('node:fs/promises', () => ({ readdir: vi.fn(), lstat: vi.fn() }));
vi.mock('../../core/epub/validate.js', () => ({ validateEpub: vi.fn() }));

const readdirMock = vi.mocked(readdir);
const lstatMock = vi.mocked(lstat);
const validateEpubMock = vi.mocked(validateEpub);

const BOOK_ID = 42;
const BOOK_PATH = '/library/Author/Book';
const LIBRARY_ROOT = '/library';

function createMockLogger() {
  const log = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'debug', silent: vi.fn(),
  };
  return { log: log as unknown as FastifyBaseLogger, spies: log };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: forced by test`), { code });
}

/**
 * Assert a logged `error` value is the output of `serializeError`, not the caught `Error`.
 *
 * The own-ENUMERABLE key set is what makes this discriminating: on a real `Error`, `message`
 * and `stack` are non-enumerable, so a `toMatchObject` matcher reads through to them and
 * passes on a raw `Error` too. Mirrors `companion-ebook-open.test.ts`.
 */
function expectSerializedError(logged: unknown, original: Error, expected: { code?: string }): void {
  expect(logged).not.toBe(original);
  expect(logged).not.toBeInstanceOf(Error);
  expect(Object.keys(logged as object).sort()).toEqual(
    expected.code === undefined ? ['message', 'stack', 'type'] : ['code', 'message', 'stack', 'type'],
  );
  expect(logged).toEqual({
    message: original.message,
    stack: expect.stringContaining(original.message),
    type: 'Error',
    ...(expected.code !== undefined && { code: expected.code }),
  });
}

/** Every `debug` record that carries an `error` key — the AC2 absorb-and-log sites. */
function errorDebugRecords(spies: { debug: ReturnType<typeof vi.fn> }): Array<Record<string, unknown>> {
  return spies.debug.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((record) => record !== null && typeof record === 'object' && 'error' in record);
}

const DEFAULT_FINGERPRINT = { size: 4096, mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_500 };

function fileStats(overrides: Partial<typeof DEFAULT_FINGERPRINT> & { regular?: boolean } = {}): Stats {
  const { regular = true, ...fingerprint } = overrides;
  return {
    ...DEFAULT_FINGERPRINT,
    ...fingerprint,
    isFile: () => regular,
  } as unknown as Stats;
}

/**
 * Queue `lstat` results in call order. Discovery probes each lexical candidate first (one call
 * per candidate, code-point order), then the observer's pre-validation stat, then its
 * post-validation re-check — so the sequence is total and readable.
 */
function queueLstat(...results: Array<Stats | Error>): void {
  for (const result of results) {
    if (result instanceof Error) lstatMock.mockRejectedValueOnce(result);
    else lstatMock.mockResolvedValueOnce(result);
  }
}

/** A stored row, defaulting to a short-circuitable `available` observation of `book.epub`. */
function priorRow(overrides: Partial<CompanionEbookRow> = {}): CompanionEbookRow {
  return {
    bookId: BOOK_ID,
    status: 'available',
    filename: 'book.epub',
    sizeBytes: DEFAULT_FINGERPRINT.size,
    mtimeMs: DEFAULT_FINGERPRINT.mtimeMs,
    ctimeMs: DEFAULT_FINGERPRINT.ctimeMs,
    validationCode: null,
    candidateCount: 1,
    selectedFilename: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as CompanionEbookRow;
}

function observe(prior: CompanionEbookRow | null, log: FastifyBaseLogger) {
  return observeCompanionEbook({ bookId: BOOK_ID, bookPath: BOOK_PATH, libraryRoot: LIBRARY_ROOT, prior }, log);
}

describe('observeCompanionEbook (#1959)', () => {
  beforeEach(() => {
    // resetAllMocks, never clearAllMocks: this suite leans on `*Once()` queues throughout and
    // clearAllMocks does not drain them (vitest-clearallmocks-once-queue).
    vi.resetAllMocks();
    validateEpubMock.mockResolvedValue({ status: 'available' });
  });

  describe('discovery dispositions (AC4/AC5)', () => {
    it('returns retain when the directory is gone, without validating (case 1)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockRejectedValue(errno('ENOENT'));

      await expect(observe(priorRow(), log)).resolves.toEqual({ outcome: 'retain' });
      expect(validateEpubMock).not.toHaveBeenCalled();
      expect(lstatMock).not.toHaveBeenCalled();
    });

    it('returns retain when discovery is undetermined (case 2)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockRejectedValue(errno('EACCES'));

      await expect(observe(priorRow(), log)).resolves.toEqual({ outcome: 'retain' });
      expect(validateEpubMock).not.toHaveBeenCalled();
    });

    it('observes `none` when the folder holds no candidates (case 3)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['cover.jpg', 'book.m4b'] as never);

      await expect(observe(priorRow(), log)).resolves.toEqual({
        outcome: 'observed',
        observation: { status: 'none' },
      });
      expect(validateEpubMock).not.toHaveBeenCalled();
    });
  });

  describe('the single-candidate happy path', () => {
    it('validates once and carries the whole fingerprint (case 4)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats());

      await expect(observe(null, log)).resolves.toEqual({
        outcome: 'observed',
        observation: {
          status: 'available',
          filename: 'book.epub',
          sizeBytes: 4096,
          mtimeMs: 1_700_000_000_000,
          ctimeMs: 1_700_000_000_500,
          candidateCount: 1,
          selected: false,
        },
      });
      expect(validateEpubMock).toHaveBeenCalledTimes(1);
      expect(validateEpubMock).toHaveBeenCalledWith(join(BOOK_PATH, 'book.epub'));
    });
  });

  describe('the fingerprint short-circuit (AC7/AC9)', () => {
    it('short-circuits on an identical prior row and never validates (case 5)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats());

      await expect(observe(priorRow(), log)).resolves.toEqual({ outcome: 'unchanged' });
      expect(validateEpubMock).not.toHaveBeenCalled();
    });

    it('still short-circuits when lstat reports a fractional mtime (case 6)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(
        fileStats({ mtimeMs: 1_699_999_999_999.5 }),
        fileStats({ mtimeMs: 1_699_999_999_999.5 }),
      );

      await expect(observe(priorRow({ mtimeMs: 1_699_999_999_999 }), log)).resolves.toEqual({
        outcome: 'unchanged',
      });
      expect(validateEpubMock).not.toHaveBeenCalled();
    });

    it('truncates toward zero, so a negative fractional mtime still matches (case 7)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats({ mtimeMs: -123.75 }), fileStats({ mtimeMs: -123.75 }));

      // Math.floor(-123.75) === -124 and would miss this row forever.
      await expect(observe(priorRow({ mtimeMs: -123 }), log)).resolves.toEqual({ outcome: 'unchanged' });
      expect(validateEpubMock).not.toHaveBeenCalled();
    });

    it('MISSES when only ctime moved — the cp -p / rsync --times case (case 8)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      const moved = { ctimeMs: DEFAULT_FINGERPRINT.ctimeMs + 5_000 };
      queueLstat(fileStats(moved), fileStats(moved), fileStats(moved));

      const result = await observe(priorRow(), log);

      expect(validateEpubMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        outcome: 'observed',
        observation: expect.objectContaining({ status: 'available', ctimeMs: DEFAULT_FINGERPRINT.ctimeMs + 5_000 }),
      });
    });

    /**
     * One row per term of AC9's conjunction that the surrounding cases do not already move, so
     * deleting ANY single comparison in `isUnchanged` fails a named case. `filename`, `size`,
     * and `mtime` were the three that had no mismatch case at all: a short-circuit that ignored
     * them would let genuinely different bytes inherit the stored verdict.
     */
    it.each([
      {
        term: 'filename',
        prior: { filename: 'a-different.epub' } as const,
        // A prior recorded against another basename cannot vouch for this one's bytes.
      },
      { term: 'sizeBytes', prior: { sizeBytes: DEFAULT_FINGERPRINT.size - 1 } as const },
      { term: 'mtimeMs', prior: { mtimeMs: DEFAULT_FINGERPRINT.mtimeMs - 1 } as const },
    ])('misses when only $term differs, forcing revalidation (F5)', async ({ prior }) => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats());

      const result = await observe(priorRow(prior), log);

      expect(validateEpubMock).toHaveBeenCalledExactlyOnceWith(join(BOOK_PATH, 'book.epub'));
      expect(result).toEqual({
        outcome: 'observed',
        observation: {
          status: 'available',
          filename: 'book.epub',
          sizeBytes: DEFAULT_FINGERPRINT.size,
          mtimeMs: DEFAULT_FINGERPRINT.mtimeMs,
          ctimeMs: DEFAULT_FINGERPRINT.ctimeMs,
          candidateCount: 1,
          selected: false,
        },
      });
    });

    it('misses when the candidate count moved 1 → 2 (case 9)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub', 'extra.epub'] as never);
      // Two discovery probes, then the resolved-file stat and its re-check.
      queueLstat(fileStats(), fileStats(), fileStats(), fileStats());

      const result = await observe(priorRow({ selectedFilename: 'book.epub' }), log);

      expect(validateEpubMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        outcome: 'observed',
        observation: expect.objectContaining({ candidateCount: 2, selected: true }),
      });
    });

    it('misses when a prior selection was recorded but `selected` is now false', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats());

      // prior.selectedFilename is non-null while the live resolution selects nothing:
      // `(prior.selectedFilename !== null) === selected` fails, so the pass revalidates.
      const result = await observe(priorRow({ selectedFilename: 'gone.epub' }), log);

      expect(validateEpubMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        outcome: 'observed',
        observation: expect.objectContaining({ selected: false, candidateCount: 1 }),
      });
    });

    it('never short-circuits off a `none` or `ambiguous` prior', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats());

      await observe(priorRow({ status: 'none', filename: null, candidateCount: 0 }), log);

      expect(validateEpubMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('candidate resolution (AC6)', () => {
    it('reports ambiguous with no filename when two candidates and no selection (case 10)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['a.epub', 'b.epub'] as never);
      queueLstat(fileStats(), fileStats());

      await expect(observe(null, log)).resolves.toEqual({
        outcome: 'observed',
        observation: { status: 'ambiguous', candidateCount: 2 },
      });
      expect(validateEpubMock).not.toHaveBeenCalled();
    });

    it('honours a live prior selection over the other candidate (case 11)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['a.epub', 'b.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats(), fileStats());

      const result = await observe(priorRow({ filename: 'b.epub', selectedFilename: 'b.epub' }), log);

      expect(validateEpubMock).toHaveBeenCalledExactlyOnceWith(join(BOOK_PATH, 'b.epub'));
      expect(result).toEqual({
        outcome: 'observed',
        observation: expect.objectContaining({ filename: 'b.epub', candidateCount: 2, selected: true }),
      });
    });

    it('falls back to ambiguous — never another candidate — when the selection is gone (case 12)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['a.epub', 'b.epub'] as never);
      queueLstat(fileStats(), fileStats());

      const result = await observe(priorRow({ filename: 'c.epub', selectedFilename: 'c.epub' }), log);

      expect(result).toEqual({
        outcome: 'observed',
        observation: { status: 'ambiguous', candidateCount: 2 },
      });
      // Only discovery's two probes ran: no candidate was stat'ed or validated by the observer.
      expect(lstatMock).toHaveBeenCalledTimes(2);
      expect(lstatMock.mock.calls.map((call) => call[0])).toEqual([
        join(BOOK_PATH, 'a.epub'),
        join(BOOK_PATH, 'b.epub'),
      ]);
      expect(validateEpubMock).not.toHaveBeenCalled();
    });
  });

  describe('validation outcomes (AC10)', () => {
    it('carries the validation code for an invalid archive (case 13)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats());
      validateEpubMock.mockResolvedValue({ status: 'invalid', code: 'empty_spine' });

      await expect(observe(null, log)).resolves.toEqual({
        outcome: 'observed',
        observation: expect.objectContaining({ status: 'invalid', validationCode: 'empty_spine' }),
      });
    });

    it('never downgrades drm_protected to invalid, and carries no validationCode (case 14)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats());
      validateEpubMock.mockResolvedValue({ status: 'drm_protected' });

      const result = await observe(null, log);

      expect(result).toEqual({
        outcome: 'observed',
        observation: {
          status: 'drm_protected',
          filename: 'book.epub',
          sizeBytes: 4096,
          mtimeMs: 1_700_000_000_000,
          ctimeMs: 1_700_000_000_500,
          candidateCount: 1,
          selected: false,
        },
      });
      expect(result).not.toHaveProperty('observation.validationCode');
    });
  });

  describe('absorbed failures (AC2/AC8/AC11/AC12)', () => {
    it('retains and logs exactly once when validation throws EACCES (case 15)', async () => {
      const { log, spies } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats());
      const error = errno('EACCES');
      validateEpubMock.mockRejectedValue(error);

      await expect(observe(priorRow({ mtimeMs: 1 }), log)).resolves.toEqual({ outcome: 'retain' });

      const records = errorDebugRecords(spies);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ bookId: BOOK_ID, path: join(BOOK_PATH, 'book.epub') });
      expectSerializedError(records[0]!.error, error, { code: 'EACCES' });
    });

    it('retains — never `none` — when validation throws ENOENT (case 16)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats());
      validateEpubMock.mockRejectedValue(errno('ENOENT'));

      await expect(observe(null, log)).resolves.toEqual({ outcome: 'retain' });
    });

    /**
     * One row per component of the post-validation fingerprint re-check, so deleting ANY of the
     * three comparisons in `sameFingerprint` fails a named case. The file is replaced WHILE
     * `validateEpub` is reading it: persisting the verdict against the new bytes is exactly the
     * state AC12 exists to prevent, and `size` and `ctime` had no case before (F6).
     */
    it.each([
      { component: 'mtimeMs', after: { mtimeMs: DEFAULT_FINGERPRINT.mtimeMs + 1 } },
      { component: 'sizeBytes', after: { size: DEFAULT_FINGERPRINT.size + 1 } },
      { component: 'ctimeMs', after: { ctimeMs: DEFAULT_FINGERPRINT.ctimeMs + 1 } },
    ])('retains when only $component moved during validation (case 17/F6)', async ({ after }) => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      queueLstat(fileStats(), fileStats(), fileStats(after));

      await expect(observe(null, log)).resolves.toEqual({ outcome: 'retain' });
      expect(validateEpubMock).toHaveBeenCalledTimes(1);
    });

    it('retains and logs the canonical record when the post-validation lstat throws (case 18)', async () => {
      const { log, spies } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      const error = errno('ESTALE');
      queueLstat(fileStats(), fileStats(), error);

      await expect(observe(null, log)).resolves.toEqual({ outcome: 'retain' });

      const records = errorDebugRecords(spies);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ bookId: BOOK_ID, path: join(BOOK_PATH, 'book.epub') });
      expectSerializedError(records[0]!.error, error, { code: 'ESTALE' });
    });

    it('retains when the pre-validation lstat reports a non-regular file (case 19)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      // Discovery proved it regular; the directory changed under the pass.
      queueLstat(fileStats(), fileStats({ regular: false }));

      await expect(observe(null, log)).resolves.toEqual({ outcome: 'retain' });
      expect(validateEpubMock).not.toHaveBeenCalled();
    });

    it('retains and logs the canonical record when the pre-validation lstat throws code-lessly (F6)', async () => {
      const { log, spies } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      const error = new Error('no errno at all');
      queueLstat(fileStats(), error);

      await expect(observe(null, log)).resolves.toEqual({ outcome: 'retain' });

      const records = errorDebugRecords(spies);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ bookId: BOOK_ID, path: join(BOOK_PATH, 'book.epub') });
      expectSerializedError(records[0]!.error, error, {});
      expect(validateEpubMock).not.toHaveBeenCalled();
    });

    it('retains when a same-fingerprint non-regular entry replaced the file (case 20)', async () => {
      const { log } = createMockLogger();
      readdirMock.mockResolvedValue(['book.epub'] as never);
      // Identical normalised size/mtime/ctime — only `isFile()` differs, which is the whole point.
      queueLstat(fileStats(), fileStats(), fileStats({ regular: false }));

      await expect(observe(null, log)).resolves.toEqual({ outcome: 'retain' });
      expect(validateEpubMock).toHaveBeenCalledTimes(1);
    });

    it('never throws — an unforeseen failure reaches the backstop and still retains (AC2)', async () => {
      const { log, spies } = createMockLogger();
      // A resolved-but-wrong `readdir` value throws OUTSIDE discovery's own try/catch (it wraps
      // the await only), so this is the one shape that actually reaches the outer backstop.
      readdirMock.mockResolvedValue(null as never);

      await expect(observe(null, log)).resolves.toEqual({ outcome: 'retain' });

      const records = errorDebugRecords(spies);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ bookId: BOOK_ID, path: BOOK_PATH });
      expect(records[0]!.error).toMatchObject({ type: 'TypeError' });
    });
  });
});
