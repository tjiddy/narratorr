import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  createMockLogger,
  createMockDb,
  mockDbChain,
  inject,
  createMockSettingsService,
} from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { BulkOperationService, BulkOpError } from './bulk-operation.service.js';
import { RenameError } from './rename.service.js';
import { RetagError } from './tagging.service.js';
import { writeOpfSidecar } from '../utils/opf-writer.js';
import { downloadRemoteCover } from './cover-download.js';
import { readdir } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { RenameService } from './rename.service.js';
import type { TaggingService } from './tagging.service.js';
import type { BookService } from './book.service.js';
import type { ConnectorService } from './connector.service.js';
import type { CompanionSweepTrigger } from './companion-ebook-trigger.js';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

/** Serialize a Drizzle SQL expression into a raw SQL+params pair for predicate assertions. */
const dialect = new SQLiteSyncDialect();
function toSQL(expr: unknown): { sql: string; params: unknown[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((expr as any).getSQL());
}

// #1670 — the reconcile job composes the OPF writer + cover downloader; mock them at their module
// boundaries to drive per-book outcomes (isRemoteCoverUrl stays real for the remote/local gate).
vi.mock('../utils/opf-writer.js', () => ({
  writeOpfSidecar: vi.fn().mockResolvedValue('written'),
}));
vi.mock('./cover-download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cover-download.js')>()),
  downloadRemoteCover: vi.fn().mockResolvedValue('written'),
}));


vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

const BOOK_PATH = '/library/Author/Title';

function makeRenameService() {
  return inject<RenameService>({
    renameBook: vi.fn(),
  });
}

function makeTaggingService() {
  return inject<TaggingService>({
    retagBook: vi.fn(),
  });
}

function makeBookService(overrides?: Record<string, unknown>) {
  const book = {
    ...createMockDbBook({ id: 1, path: BOOK_PATH, status: 'imported' }),
    authors: [{ name: 'Author Name' }],
    narrators: [],
    ...overrides,
  };
  return inject<BookService>({
    getById: vi.fn().mockResolvedValue(book),
  });
}

function createService(opts?: {
  settingsOverrides?: Record<string, unknown>;
  renameService?: RenameService;
  taggingService?: TaggingService;
  bookService?: BookService;
  connectorService?: { notifyRefresh: ReturnType<typeof vi.fn> };
  companionEbook?: CompanionSweepTrigger;
}) {
  const db = createMockDb();
  const log = createMockLogger();
  const renameService = opts?.renameService ?? makeRenameService();
  const taggingService = opts?.taggingService ?? makeTaggingService();
  const bookService = opts?.bookService ?? makeBookService();
  const settingsService = createMockSettingsService({
    library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '' },
    processing: { outputFormat: 'm4b' as const, bitrate: 128, keepOriginalBitrate: false, maxConcurrentProcessing: 1, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    ...opts?.settingsOverrides,
  });
  const connectorService = opts?.connectorService;
  const service = new BulkOperationService(
    inject<Db>(db),
    renameService,
    taggingService,
    settingsService,
    bookService,
    inject<FastifyBaseLogger>(log),
    connectorService ? inject<ConnectorService>(connectorService) : undefined,
    opts?.companionEbook,
  );
  return { service, db, log, renameService, taggingService, bookService, settingsService, connectorService };
}

async function waitForJob(service: BulkOperationService, jobId: string, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const status = service.getJob(jobId);
    if (!status || status.status === 'completed') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('waitForJob timed out');
}

// ===== waitForJob helper tests =====

describe('waitForJob helper', () => {
  it('rejects with timeout error when job never reaches completed', async () => {
    const stalledService = {
      getJob: vi.fn().mockReturnValue({ status: 'running' }),
    } as unknown as BulkOperationService;
    await expect(waitForJob(stalledService, 'any-job-id', 50)).rejects.toThrow('waitForJob timed out');
  });
});

// ===== Count tests =====

describe('BulkOperationService — countRetagEligible', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns total count of imported books with non-null path', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ count: 5 }]));
    const result = await service.countRetagEligible();
    expect(result).toEqual({ total: 5 });
  });

  it('returns 0 when no books eligible', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ count: 0 }]));
    const result = await service.countRetagEligible();
    expect(result).toEqual({ total: 0 });
  });
});

describe('BulkOperationService — previewRenameEligible', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  function bookRow(overrides: Record<string, unknown>) {
    return {
      id: 1, path: '/library/Author Name/OldName', title: 'Book1',
      seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name',
      ...overrides,
    };
  }

  it('returns library-relative from→to rows (from !== to) plus totals for inside-root books', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }), // matches
      bookRow({ id: 2, path: '/library/Author Name/OldName', title: 'Book2' }), // mismatched
    ]));
    const result = await service.previewRenameEligible();
    expect(result.mismatchedTotal).toBe(1);
    expect(result.folderMatching).toBe(1);
    expect(result.importedTotal).toBe(2);
    // fileFormat is empty in the default settings, so the job only visits mismatches.
    expect(result.jobTotal).toBe(1);
    expect(result.items).toEqual([
      { bookId: 2, title: 'Book2', from: 'Author Name/OldName', to: 'Author Name/Book2' },
    ]);
    expect(result.items.every(i => i.from !== i.to)).toBe(true);
    expect(result).toMatchObject({ libraryRoot: '/library', folderFormat: '{author}/{title}' });
  });

  it('uses the toLibraryRelative outside-root fallback: from is the original absolute path', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 5, path: '/elsewhere/Author Name/Book5', title: 'Book5' }),
    ]));
    const result = await service.previewRenameEligible();
    expect(result.items[0]).toEqual({
      bookId: 5, title: 'Book5', from: '/elsewhere/Author Name/Book5', to: 'Author Name/Book5',
    });
  });

  it('caps items at the row cap while mismatchedTotal reflects the true total', async () => {
    const { service, db } = createService();
    const rows = Array.from({ length: 150 }, (_, i) =>
      bookRow({ id: i + 1, path: `/library/Author Name/Old${i}`, title: `Book${i}` }));
    db.select.mockReturnValueOnce(mockDbChain(rows));
    const result = await service.previewRenameEligible();
    expect(result.items).toHaveLength(100);
    expect(result.mismatchedTotal).toBe(150);
  });

  it('skips rows with no path (mirrors count/job NO_PATH skip) rather than emitting a broken row', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 1, path: null, title: 'NoPath' }),
      bookRow({ id: 2, path: '/library/Author Name/OldName', title: 'Book2' }),
    ]));
    const result = await service.previewRenameEligible();
    expect(result.mismatchedTotal).toBe(1);
    expect(result.items.map(i => i.bookId)).toEqual([2]);
  });

  it('counts a backslash-stored path that resolves to the same target as folderMatching', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 1, path: '/library/Author Name/Book1'.split('/').join('\\'), title: 'Book1' }),
    ]));
    const result = await service.previewRenameEligible();
    expect(result.folderMatching).toBe(1);
    expect(result.mismatchedTotal).toBe(0);
  });

  it('deduplicates a multi-author book into exactly one preview row', async () => {
    const { service, db } = createService();
    // Same bookId joined to two authors yields two rows; preview must collapse to one.
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 7, path: '/library/Author Name/OldName', title: 'Book7', authorName: 'Author Name' }),
      bookRow({ id: 7, path: '/library/Author Name/OldName', title: 'Book7', authorName: 'Second Author' }),
    ]));
    const result = await service.previewRenameEligible();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.bookId).toBe(7);
  });

  it('does not touch the filesystem (no readdir) for the bulk preview', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 2, path: '/library/Author Name/OldName', title: 'Book2' }),
    ]));
    await service.previewRenameEligible();
    expect(readdir).not.toHaveBeenCalled();
  });

  // Narrator-token parity (AC #3/#7): preview, job, and the shared helper all render
  // {narrator} from the ordered narrators supplied by the extended projection.
  it('renders {narrator} folder formats from the ordered narrator projection', async () => {
    const { service, db } = createService({
      settingsOverrides: { library: { path: '/library', folderFormat: '{narrator}/{title}', fileFormat: '' } },
    });
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 1, path: '/library/Michael Kramer/The Way of Kings', title: 'The Way of Kings' }),
      ]))
      .mockReturnValueOnce(mockDbChain([
        { bookId: 1, name: 'Michael Kramer', position: 0 },
        { bookId: 1, name: 'Kate Reading', position: 1 },
      ]));
    const result = await service.previewRenameEligible();
    // Path already matches the narrator-based target → no rename needed. Without the
    // narrator projection the target would render with an empty {narrator} and mismatch.
    expect(result.folderMatching).toBe(1);
    expect(result.mismatchedTotal).toBe(0);
  });

  it('renders the {edition} folder token from the loaded editionLabel projection (#1712)', async () => {
    const { service, db } = createService({
      settingsOverrides: { library: { path: '/library', folderFormat: '{author}/{title} ({edition})', fileFormat: '' } },
    });
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 1, path: '/library/Blake Crouch/OldName', title: 'Dark Matter', authorName: 'Blake Crouch', editionLabel: 'Full Cast' }),
      ]))
      .mockReturnValueOnce(mockDbChain([]));
    const result = await service.previewRenameEligible();
    // The loaded edition_label feeds the {edition} token; no doubled suffix (template carries the token).
    expect(result.items[0]?.to).toBe('Blake Crouch/Dark Matter (Full Cast)');
  });

  it('preview mismatch decision agrees with the bulk job (shared-helper parity)', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ renameService });
    const rows = [
      bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }), // matches
      bookRow({ id: 2, path: '/library/Author Name/OldName', title: 'Book2' }), // mismatched
    ];
    // previewRenameEligible (2 selects: books, narrators) then the job (2 more).
    db.select
      .mockReturnValueOnce(mockDbChain(rows))
      .mockReturnValueOnce(mockDbChain([]))
      .mockReturnValueOnce(mockDbChain(rows))
      .mockReturnValueOnce(mockDbChain([]));
    const preview = await service.previewRenameEligible();
    expect(preview.items.map(i => i.bookId)).toEqual([2]);

    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Moved', filesRenamed: 0 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    expect(renameService.renameBook).toHaveBeenCalledTimes(1);
    expect(renameService.renameBook).toHaveBeenCalledWith(2);
  });
});

// ===== File-format eligibility (#1493) =====
// When a `fileFormat` rule exists the bulk op must visit ALL imported books, not just
// folder mismatches — a folder-matching book can still have file-level renames.

describe('BulkOperationService — fileFormat eligibility (#1493)', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  const FILE_FORMAT_SETTINGS = {
    settingsOverrides: {
      library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    },
  };

  function bookRow(overrides: Record<string, unknown>) {
    return {
      id: 1, path: '/library/Author Name/Book1', title: 'Book1',
      seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name',
      ...overrides,
    };
  }

  it('preview: a folder-matching book is still part of the job set when fileFormat is set', async () => {
    const { service, db } = createService(FILE_FORMAT_SETTINGS);
    // Folder already matches the target → zero folder mismatches.
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }),
    ]));
    const result = await service.previewRenameEligible();
    expect(result.mismatchedTotal).toBe(0);
    expect(result.folderMatching).toBe(1);
    expect(result.importedTotal).toBe(1);
    // jobTotal tracks importedTotal because file-level work is possible on every book.
    expect(result.jobTotal).toBe(1);
  });

  it('preview: fileFormat-only change is NOT "nothing to rename" (jobTotal === importedTotal)', async () => {
    const { service, db } = createService(FILE_FORMAT_SETTINGS);
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }),
      bookRow({ id: 2, path: '/library/Author Name/Book2', title: 'Book2' }),
    ]));
    const result = await service.previewRenameEligible();
    expect(result.mismatchedTotal).toBe(0);
    expect(result.importedTotal).toBe(2);
    expect(result.jobTotal).toBe(2);
  });

  it('preview: fileFormat empty keeps the folder-mismatch-only filter (jobTotal === mismatchedTotal)', async () => {
    const { service, db } = createService(); // default fileFormat is ''
    db.select.mockReturnValueOnce(mockDbChain([
      bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }), // matches
    ]));
    const result = await service.previewRenameEligible();
    expect(result.mismatchedTotal).toBe(0);
    expect(result.importedTotal).toBe(1);
    expect(result.jobTotal).toBe(0);
  });

  it('job: visits every imported book and sets total to importedTotal when fileFormat is set', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService });
    const rows = [
      bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }), // folder matches
      bookRow({ id: 2, path: '/library/Author Name/OldName', title: 'Book2' }), // folder mismatch
    ];
    db.select
      .mockReturnValueOnce(mockDbChain(rows))
      .mockReturnValueOnce(mockDbChain([]));
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Renamed 1 file(s)', filesRenamed: 1 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    // Both books visited — the folder-matching one is no longer pre-filtered out.
    expect(renameService.renameBook).toHaveBeenCalledTimes(2);
    expect(renameService.renameBook).toHaveBeenCalledWith(1);
    expect(renameService.renameBook).toHaveBeenCalledWith(2);
    expect(service.getJob(id)?.total).toBe(2);
  });

  it('job: an "Already organized" book ticks as a silent skip, not a failure', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService });
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }), // folder + file match
      ]))
      .mockReturnValueOnce(mockDbChain([]));
    // renameBook returns the idempotent "Already organized" result for a fully-organized book.
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '/library/Author Name/Book1', newPath: '/library/Author Name/Book1', message: 'Already organized', filesRenamed: 0 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.total).toBe(1);
    expect(status?.completed).toBe(1);
    expect(status?.failures).toBe(0);
  });

  it('job: a renameBook failure plus an idempotent skip tick correctly (completed=2, failures=1)', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService });
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }),
        bookRow({ id: 2, path: '/library/Author Name/Book2', title: 'Book2' }),
      ]))
      .mockReturnValueOnce(mockDbChain([]));
    // Visit order is targetIds order [1, 2]: book 1 fails (tick(true)), book 2 is the
    // idempotent "Already organized" skip (tick(false)). Both still increment completed.
    (renameService.renameBook as Mock)
      .mockRejectedValueOnce(new RenameError('conflict', 'CONFLICT'))
      .mockResolvedValueOnce({ oldPath: '/library/Author Name/Book2', newPath: '/library/Author Name/Book2', message: 'Already organized', filesRenamed: 0 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.total).toBe(2);
    expect(status?.completed).toBe(2);
    expect(status?.failures).toBe(1);
  });

  it('job: duplicate author-join rows for one book call renameBook exactly once (dedup holds on visit-all)', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService });
    // Same bookId joined to two authors yields two rows; the loadRenameRows `seen`
    // Set must collapse them so the file-rule visit-all branch still acts once per book.
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 7, path: '/library/Author Name/Book7', title: 'Book7', authorName: 'Author Name' }),
        bookRow({ id: 7, path: '/library/Author Name/Book7', title: 'Book7', authorName: 'Second Author' }),
      ]))
      .mockReturnValueOnce(mockDbChain([]));
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Renamed 1 file(s)', filesRenamed: 1 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    expect(renameService.renameBook).toHaveBeenCalledTimes(1);
    expect(renameService.renameBook).toHaveBeenCalledWith(7);
    expect(service.getJob(id)?.total).toBe(1);
  });

  it('file-rule lockstep: preview.jobTotal === job total === renameBook call count', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService });
    const rows = [
      bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }), // folder matches
      bookRow({ id: 2, path: '/library/Author Name/OldName', title: 'Book2' }), // folder mismatch
    ];
    // previewRenameEligible (2 selects: books, narrators) then the job (2 more).
    db.select
      .mockReturnValueOnce(mockDbChain(rows))
      .mockReturnValueOnce(mockDbChain([]))
      .mockReturnValueOnce(mockDbChain(rows))
      .mockReturnValueOnce(mockDbChain([]));
    const preview = await service.previewRenameEligible();
    // With a file rule, the denominator is every imported book regardless of folder match.
    expect(preview.jobTotal).toBe(preview.importedTotal);
    expect(preview.jobTotal).toBe(2);

    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Renamed 1 file(s)', filesRenamed: 1 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    // Lockstep invariant: preview denominator === job setTotal === actual renameBook calls.
    expect(service.getJob(id)?.total).toBe(preview.jobTotal);
    expect((renameService.renameBook as Mock).mock.calls).toHaveLength(preview.jobTotal);
  });
});

// ===== #1960 AC21 — rename caller 3: ONE post-loop sweep, never a per-book fan-out =====

describe('BulkOperationService — companion-ebook sweep after bulk rename (#1960 AC21)', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  const FILE_FORMAT_SETTINGS = {
    settingsOverrides: {
      library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    },
  };

  /**
   * Bulk rename is a SWEEP-only seam, so the stub carries `reconcileAll` — plus a
   * `reconcileBook` PROBE that `CompanionSweepTrigger` does not declare. AC21's whole point is
   * that a whole-library rename must NOT fan out N direct runs, and the probe is what makes
   * that assertable at runtime on top of the type-level guarantee.
   */
  function makeCompanionStub() {
    return {
      reconcileAll: vi.fn().mockResolvedValue(undefined),
      reconcileBook: vi.fn().mockResolvedValue(undefined),
    };
  }

  function bookRow(overrides: Record<string, unknown>) {
    return {
      id: 1, path: '/library/Author Name/Book1', title: 'Book1',
      seriesName: null, seriesPosition: null, publishedDate: null,
      editionLabel: null, authorName: 'Author Name',
      ...overrides,
    };
  }

  it('a rename over N books produces ONE reconcileAll and ZERO reconcileBook calls', async () => {
    const companionEbook = makeCompanionStub();
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService, companionEbook });
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }),
        bookRow({ id: 2, path: '/library/Author Name/Book2', title: 'Book2' }),
        bookRow({ id: 3, path: '/library/Author Name/Book3', title: 'Book3' }),
      ]))
      .mockReturnValueOnce(mockDbChain([]));
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Renamed 1 file(s)', filesRenamed: 1 });

    const id = await service.startRenameJob();
    await waitForJob(service, id);

    expect(renameService.renameBook).toHaveBeenCalledTimes(3);
    // N-wide direct fan-out is exactly what this AC prevents: direct runs do not coalesce.
    expect(companionEbook.reconcileBook).not.toHaveBeenCalled();
    expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
  });

  /**
   * AC21's ORDERING half. The call-count test above cannot see it: moving the sweep above the
   * `for (const bookId of targetIds)` loop preserves "3 renames, 1 sweep" exactly, and every
   * status assertion with it — while the sweep would then observe the OLD paths and miss every
   * folder the rename just moved.
   *
   * The final rename is held pending, so "no sweep yet" is observed while the loop is provably
   * still mid-flight, and the ordered trace pins the sweep strictly after the last rename
   * returns.
   */
  it('AC21: the sweep runs strictly AFTER the loop — held on the final rename, no sweep until it settles', async () => {
    const order: string[] = [];
    const companionEbook = {
      reconcileAll: vi.fn().mockImplementation(() => { order.push('sweep'); return Promise.resolve(); }),
      reconcileBook: vi.fn().mockResolvedValue(undefined),
    };
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService, companionEbook });
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }),
        bookRow({ id: 2, path: '/library/Author Name/Book2', title: 'Book2' }),
        bookRow({ id: 3, path: '/library/Author Name/Book3', title: 'Book3' }),
      ]))
      .mockReturnValueOnce(mockDbChain([]));

    let releaseFinalRename!: () => void;
    const finalRenameHeld = new Promise<void>((r) => { releaseFinalRename = r; });
    let markFinalRenameStarted!: () => void;
    const finalRenameStarted = new Promise<void>((r) => { markFinalRenameStarted = r; });

    (renameService.renameBook as Mock).mockImplementation(async (bookId: number) => {
      order.push(`rename:${bookId}`);
      if (bookId === 3) {
        markFinalRenameStarted();
        await finalRenameHeld;
      }
      return { oldPath: '', newPath: '', message: 'Renamed 1 file(s)', filesRenamed: 1 };
    });

    const id = await service.startRenameJob();
    await finalRenameStarted;
    // Room for any pending microtask AND a macrotask turn — a sweep hoisted above the loop
    // would already have run by this point.
    await new Promise(r => setTimeout(r, 20));

    expect(order).toEqual(['rename:1', 'rename:2', 'rename:3']);
    expect(companionEbook.reconcileAll).not.toHaveBeenCalled();

    releaseFinalRename();
    await waitForJob(service, id);

    expect(order).toEqual(['rename:1', 'rename:2', 'rename:3', 'sweep']);
    expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
  });

  it('fires once even when some books failed mid-loop', async () => {
    const companionEbook = makeCompanionStub();
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService, companionEbook });
    db.select
      .mockReturnValueOnce(mockDbChain([
        bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' }),
        bookRow({ id: 2, path: '/library/Author Name/Book2', title: 'Book2' }),
      ]))
      .mockReturnValueOnce(mockDbChain([]));
    (renameService.renameBook as Mock)
      .mockRejectedValueOnce(new RenameError('conflict', 'CONFLICT'))
      .mockResolvedValueOnce({ oldPath: '', newPath: '', message: 'Renamed 1 file(s)', filesRenamed: 1 });

    const id = await service.startRenameJob();
    await waitForJob(service, id);

    expect(service.getJob(id)?.failures).toBe(1);
    expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
  });

  it('is NOT fired when the target set is empty', async () => {
    const companionEbook = makeCompanionStub();
    const { service, db } = createService({ companionEbook });
    db.select.mockReturnValue(mockDbChain([])); // no eligible rows at all

    const id = await service.startRenameJob();
    await waitForJob(service, id);

    expect(service.getJob(id)?.total).toBe(0);
    expect(companionEbook.reconcileAll).not.toHaveBeenCalled();
  });

  it('a rejecting sweep does not fail the job', async () => {
    const companionEbook = { reconcileAll: vi.fn().mockRejectedValue(new Error('sweep rejected')) };
    const renameService = makeRenameService();
    const { service, db } = createService({ ...FILE_FORMAT_SETTINGS, renameService, companionEbook });
    db.select
      .mockReturnValueOnce(mockDbChain([bookRow({ id: 1, path: '/library/Author Name/Book1', title: 'Book1' })]))
      .mockReturnValueOnce(mockDbChain([]));
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Renamed 1 file(s)', filesRenamed: 1 });

    const id = await service.startRenameJob();
    await waitForJob(service, id);

    expect(service.getJob(id)?.failures).toBe(0);
    expect(service.getJob(id)?.status).toBe('completed');
  });
});

// ===== Job lifecycle tests =====

describe('BulkOperationService — job lifecycle', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('startRenameJob returns UUID immediately (non-blocking)', async () => {
    const { service, db } = createService();
    db.select.mockReturnValue(mockDbChain([])); // empty batch
    const id = await service.startRenameJob();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(36); // UUID format
  });

  it('startRetagJob returns UUID immediately', async () => {
    const { service, db } = createService();
    db.select.mockReturnValue(mockDbChain([]));
    const id = service.startRetagJob();
    expect(typeof id).toBe('string');
  });

  it('getJob returns null for unknown jobId', () => {
    const { service } = createService();
    expect(service.getJob('nonexistent')).toBeNull();
  });

  it('getJob returns status immediately after start', async () => {
    const { service, db } = createService();
    db.select.mockReturnValue(mockDbChain([]));
    const id = await service.startRenameJob();
    const status = service.getJob(id);
    expect(status).not.toBeNull();
    expect(status?.jobId).toBe(id);
    expect(status?.type).toBe('rename');
  });

  it('getJob returns completed status after job finishes', async () => {
    const { service, db } = createService();
    db.select.mockReturnValue(mockDbChain([])); // no books — completes immediately
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.status).toBe('completed');
  });

  it('getActiveJob returns running job while job is in progress', async () => {
    const { service, db, renameService } = createService();
    // Make rename take a bit so we can check mid-flight
    let resolveRename!: () => void;
    const renamePromise = new Promise<void>(r => { resolveRename = r; });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/Author Name/OldName', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
    ]));
    (renameService.renameBook as Mock).mockReturnValueOnce(renamePromise.then(() => ({ oldPath: '', newPath: '', message: 'ok', filesRenamed: 0 })));
    const id = await service.startRenameJob();
    await new Promise(r => setTimeout(r, 20)); // let job start
    const active = service.getActiveJob();
    expect(active?.jobId).toBe(id);
    expect(active?.status).toBe('running');
    resolveRename();
    await waitForJob(service, id);
  });

  it('getActiveJob returns null after job completes', async () => {
    const { service, db } = createService();
    db.select.mockReturnValue(mockDbChain([]));
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    expect(service.getActiveJob()).toBeNull();
  });

  it('getActiveJob returns null when no job started', () => {
    const { service } = createService();
    expect(service.getActiveJob()).toBeNull();
  });
});

// ===== Cross-operation exclusivity =====

describe('BulkOperationService — cross-operation exclusivity', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  function makeStallService() {
    const { service, db } = createService();
    // Stall on the batch query so job stays in running state
    let resolveQuery!: (rows: unknown[]) => void;
    const queryPromise = new Promise<unknown[]>(r => { resolveQuery = r; });
    db.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(queryPromise),
    });
    return { service, db, resolveQuery };
  }

  it('startRetagJob while rename is running throws BULK_OP_IN_PROGRESS', async () => {
    const { service, resolveQuery } = makeStallService();
    void service.startRenameJob();
    await new Promise(r => setTimeout(r, 10));
    expect(() => service.startRetagJob()).toThrow(BulkOpError);
    expect(() => service.startRetagJob()).toThrow(expect.objectContaining({ code: 'BULK_OP_IN_PROGRESS' }));
    resolveQuery([]);
  });

  it('startRenameJob while retag is running throws BULK_OP_IN_PROGRESS', async () => {
    const { service, db } = createService();
    let resolveFn!: (v: unknown[]) => void;
    db.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(new Promise(r => { resolveFn = r; })),
    });
    service.startRetagJob();
    await new Promise(r => setTimeout(r, 10));
    await expect(service.startRenameJob()).rejects.toThrow(expect.objectContaining({ code: 'BULK_OP_IN_PROGRESS' }));
    resolveFn([]);
  });

  it('a new job can start after the previous job completes', async () => {
    const { service, db } = createService();
    db.select.mockReturnValue(mockDbChain([]));
    const id1 = await service.startRenameJob();
    await waitForJob(service, id1);
    // Should not throw
    const id2 = service.startRetagJob();
    expect(id2).toBeTruthy();
    await waitForJob(service, id2);
  });
});

// ===== Pre-flight validation =====

describe('BulkOperationService — pre-flight validation', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('startRenameJob throws LIBRARY_NOT_CONFIGURED when library path is empty', async () => {
    const { service } = createService({
      settingsOverrides: {
        library: { path: '', folderFormat: '{author}/{title}', fileFormat: '' },
      },
    });
    await expect(service.startRenameJob()).rejects.toThrow(expect.objectContaining({ code: 'LIBRARY_NOT_CONFIGURED' }));
  });
});

// ===== Rename batch =====

describe('BulkOperationService — rename batch', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('processes only mismatched books; skips already-matching', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ renameService });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/Author Name/Book1', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' }, // matches
      { id: 2, path: '/library/Author Name/OldName', title: 'Book2', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' }, // mismatched
    ]));
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Moved', filesRenamed: 0 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    // Only the mismatched book should have been renamed
    expect(renameService.renameBook).toHaveBeenCalledTimes(1);
    expect(renameService.renameBook).toHaveBeenCalledWith(2);
  });

  it('counts CONFLICT failure, continues remaining books', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ renameService });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/Old1', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'A' },
      { id: 2, path: '/library/Old2', title: 'Book2', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'B' },
    ]));
    (renameService.renameBook as Mock)
      .mockRejectedValueOnce(new RenameError('conflict', 'CONFLICT'))
      .mockResolvedValueOnce({ oldPath: '', newPath: '', message: 'ok', filesRenamed: 0 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.failures).toBe(1);
    expect(status?.completed).toBe(2);
    expect(renameService.renameBook).toHaveBeenCalledTimes(2);
  });

  it('reports final completed, total, failures counts', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({ renameService });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 3, path: '/old/path', title: 'Book3', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'C' },
    ]));
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Moved', filesRenamed: 0 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.status).toBe('completed');
    expect(status?.total).toBe(1);
    expect(status?.completed).toBe(1);
    expect(status?.failures).toBe(0);
  });
});

describe('BulkOperationService — rename naming options wiring', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('non-default namingSeparator/namingCase affect rename path comparison', async () => {
    // With separator=period, case=upper: buildTargetPath produces /library/AUTHOR.NAME/BOOK1
    // A book whose current path already matches this should be "folderMatching"
    const { service, db } = createService({
      settingsOverrides: {
        library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '', namingSeparator: 'period' as const, namingCase: 'upper' as const },
      },
    });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/AUTHOR.NAME/BOOK1', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
      { id: 2, path: '/library/Author Name/Book2', title: 'Book2', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
    ]));
    const result = await service.previewRenameEligible();
    // Book1 path matches the transformed target — folder matching
    expect(result.folderMatching).toBe(1);
    // Book2 path uses default spacing/casing — mismatched under new settings
    expect(result.mismatchedTotal).toBe(1);
  });

  it('startRenameJob only renames books whose path does not match the transformed target', async () => {
    const renameService = makeRenameService();
    const { service, db } = createService({
      renameService,
      settingsOverrides: {
        library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '', namingSeparator: 'period' as const, namingCase: 'upper' as const },
      },
    });
    db.select.mockReturnValueOnce(mockDbChain([
      // Book1 path matches transformed target (AUTHOR.NAME/BOOK1) — should be skipped
      { id: 1, path: '/library/AUTHOR.NAME/BOOK1', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
      // Book2 path uses default format — mismatched under period/upper settings
      { id: 2, path: '/library/Author Name/Book2', title: 'Book2', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
    ]));
    (renameService.renameBook as Mock).mockResolvedValue({ oldPath: '', newPath: '', message: 'Moved', filesRenamed: 0 });
    const id = await service.startRenameJob();
    await waitForJob(service, id);
    // Only the mismatched book (id=2) should be processed
    expect(renameService.renameBook).toHaveBeenCalledTimes(1);
    expect(renameService.renameBook).toHaveBeenCalledWith(2);
  });
});

// ===== Re-tag batch =====

describe('BulkOperationService — re-tag batch', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('skips book with NO_PATH silently (not counted as failure)', async () => {
    const taggingService = makeTaggingService();
    const { service, db } = createService({ taggingService });
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1 }, { id: 2 }]));
    (taggingService.retagBook as Mock)
      .mockRejectedValueOnce(new RetagError('NO_PATH', 'no path'))
      .mockResolvedValueOnce({ bookId: 2, filesTagged: 1, message: 'ok' });
    const id = service.startRetagJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.failures).toBe(0);
    expect(status?.completed).toBe(2);
  });

  it('counts PATH_MISSING as failure, continues batch', async () => {
    const taggingService = makeTaggingService();
    const { service, db } = createService({ taggingService });
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1 }, { id: 2 }]));
    (taggingService.retagBook as Mock)
      .mockRejectedValueOnce(new RetagError('PATH_MISSING', 'missing'))
      .mockResolvedValueOnce({ bookId: 2, filesTagged: 1, message: 'ok' });
    const id = service.startRetagJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.failures).toBe(1);
    expect(status?.completed).toBe(2);
  });

  it('reports completed status with final counts', async () => {
    const taggingService = makeTaggingService();
    const { service, db } = createService({ taggingService });
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
    (taggingService.retagBook as Mock).mockResolvedValue({ bookId: 1, filesTagged: 2, message: 'ok' });
    const id = service.startRetagJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.status).toBe('completed');
    expect(status?.total).toBe(1);
    expect(status?.failures).toBe(0);
  });

  // #1707 — connector refresh after a bulk re-tag that actually tagged ≥1 file
  it("enqueues a 'metadata' refresh for a book that tagged ≥1 file, and none for an all-skipped book", async () => {
    const taggingService = makeTaggingService();
    const notifyRefresh = vi.fn().mockResolvedValue(undefined);
    const { service, db } = createService({ taggingService, connectorService: { notifyRefresh } });
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1 }, { id: 2 }]));
    (taggingService.retagBook as Mock)
      .mockResolvedValueOnce({ bookId: 1, tagged: 2, skipped: 0, failed: 0, warnings: [], refreshItem: { bookId: 1, title: 'Tagged Book', authorName: 'Author Name', libraryPath: BOOK_PATH } })
      .mockResolvedValueOnce({ bookId: 2, tagged: 0, skipped: 3, failed: 0, warnings: [], refreshItem: { bookId: 2, title: 'Skipped Book', authorName: null, libraryPath: '/library/Author/Skipped' } });
    const id = service.startRetagJob();
    await waitForJob(service, id);

    expect(notifyRefresh).toHaveBeenCalledTimes(1);
    expect(notifyRefresh).toHaveBeenCalledWith('metadata', [
      expect.objectContaining({ bookId: 1, title: 'Tagged Book', libraryPath: BOOK_PATH }),
    ]);
  });

  // #1721 — the refresh is built from RetagResult.refreshItem (loaded before the in-place tag
  // rewrite), so a transient post-re-tag book reload failure can no longer drop it. The old code
  // reloaded via bookService.getById after the mutation; this proves the refresh survives that miss.
  it("still fires the 'metadata' refresh from preloaded state when a post-retag reload would fail", async () => {
    const taggingService = makeTaggingService();
    const notifyRefresh = vi.fn().mockResolvedValue(undefined);
    // getById rejects — the new path must not depend on it for the refresh item.
    const bookService = inject<BookService>({ getById: vi.fn().mockRejectedValue(new Error('libSQL read failed')) });
    const { service, db } = createService({ taggingService, bookService, connectorService: { notifyRefresh } });
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1 }]));
    (taggingService.retagBook as Mock).mockResolvedValueOnce({
      bookId: 1, tagged: 2, skipped: 0, failed: 0, warnings: [],
      refreshItem: { bookId: 1, title: 'Tagged Book', authorName: 'Author Name', libraryPath: BOOK_PATH },
    });
    const id = service.startRetagJob();
    await waitForJob(service, id);

    expect(notifyRefresh).toHaveBeenCalledTimes(1);
    expect(notifyRefresh).toHaveBeenCalledWith('metadata', [
      expect.objectContaining({ bookId: 1, libraryPath: BOOK_PATH }),
    ]);
  });
});

// ===== Retag eligibility: single shared predicate (count ↔ job lockstep) =====

describe('BulkOperationService — retag eligibility (single source)', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('lockstep: countRetagEligible total === job setTotal === retagBook call count for the same fixture', async () => {
    const taggingService = makeTaggingService();
    const { service, db } = createService({ taggingService });
    // One fixture set of imported books with non-null paths drives both reads:
    // the count select reports count(*), the job select returns the row ids.
    const eligible = [{ id: 1 }, { id: 2 }, { id: 3 }];
    db.select
      .mockReturnValueOnce(mockDbChain([{ count: eligible.length }])) // countRetagEligible
      .mockReturnValueOnce(mockDbChain(eligible)); // startRetagJob row select
    (taggingService.retagBook as Mock).mockResolvedValue({ bookId: 1, filesTagged: 1, message: 'ok' });

    const { total } = await service.countRetagEligible();
    const id = service.startRetagJob();
    await waitForJob(service, id);

    // The preview denominator the modal shows must equal the job's real total.
    expect(total).toBe(eligible.length);
    expect(service.getJob(id)?.total).toBe(total);
    expect((taggingService.retagBook as Mock).mock.calls).toHaveLength(total);
  });

  it('no eligible books: count total === 0 and job setTotal === 0 (job touches nothing)', async () => {
    const taggingService = makeTaggingService();
    const { service, db } = createService({ taggingService });
    db.select
      .mockReturnValueOnce(mockDbChain([{ count: 0 }])) // countRetagEligible
      .mockReturnValueOnce(mockDbChain([])); // startRetagJob row select

    const { total } = await service.countRetagEligible();
    const id = service.startRetagJob();
    await waitForJob(service, id);

    expect(total).toBe(0);
    expect(service.getJob(id)?.total).toBe(0);
    expect(taggingService.retagBook).not.toHaveBeenCalled();
  });

  it('both retag call sites filter on the same predicate (imported AND path present)', async () => {
    const taggingService = makeTaggingService();
    const { service, db } = createService({ taggingService });
    const countChain = mockDbChain([{ count: 0 }]);
    const jobChain = mockDbChain([]);
    db.select
      .mockReturnValueOnce(countChain) // countRetagEligible
      .mockReturnValueOnce(jobChain); // startRetagJob row select

    await service.countRetagEligible();
    const id = service.startRetagJob();
    await waitForJob(service, id);

    const countWhere = (countChain.where as Mock).mock.calls[0]![0];
    const jobWhere = (jobChain.where as Mock).mock.calls[0]![0];
    // Structurally identical where-args prove both sites consume one shared source,
    // not two inlined copies that merely happen to agree.
    expect(toSQL(countWhere)).toEqual(toSQL(jobWhere));
    const { sql } = toSQL(countWhere);
    expect(sql).toMatch(/"books"\."status" = \?/i);
    expect(sql).toMatch(/"books"\."path" is not null/i);
  });
});
describe('TTL cleanup', () => {
  it('removes job from the jobs map after TTL expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service, db } = createService();
      // Return empty list — rename job completes immediately with 0 items
      db.select.mockReturnValueOnce(mockDbChain([]));

      const jobId = await service.startRenameJob();

      // Flush microtasks to let the async job work function complete
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(service.getJob(jobId)).not.toBeNull();
      expect(service.getJob(jobId)!.status).toBe('completed');

      // Advance past 10-minute TTL
      vi.advanceTimersByTime(10 * 60 * 1000);

      expect(service.getJob(jobId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('job remains accessible before TTL expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service, db } = createService();
      db.select.mockReturnValueOnce(mockDbChain([]));

      const jobId = await service.startRenameJob();

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(service.getJob(jobId)!.status).toBe('completed');

      // Advance 9 minutes — still within TTL
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(service.getJob(jobId)).not.toBeNull();

      // Advance past the 10-minute mark
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(service.getJob(jobId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── #229 Observability — elapsed time and correlation ───────────────────
  describe('logging improvements (#229)', () => {
    it('bulk operation completion log includes elapsedMs field', async () => {
      const { service, db, log } = createService();
      db.select.mockReturnValue(mockDbChain([])); // empty batch — completes immediately
      const id = await service.startRenameJob();
      await waitForJob(service, id);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: id, elapsedMs: expect.any(Number) }),
        'Bulk job completed',
      );
    });

    it('per-book warn logs include jobId field', async () => {
      const renameService = makeRenameService();
      (renameService.renameBook as Mock).mockRejectedValueOnce(new Error('rename failed'));
      const { service, db, log } = createService({ renameService });
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, path: '/library/Author Name/OldName', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
      ]));
      const id = await service.startRenameJob();
      await waitForJob(service, id);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: id, bookId: 1 }),
        expect.stringContaining('book failed'),
      );
    });
  });
});

// ===== Library reconcile: write/refresh metadata sidecars (#1670) =====

describe('BulkOperationService — startWriteMetadataSidecarsJob (#1670)', () => {
  const writeOpfMock = vi.mocked(writeOpfSidecar);
  const downloadMock = vi.mocked(downloadRemoteCover);

  beforeEach(() => {
    vi.resetAllMocks();
    writeOpfMock.mockResolvedValue('written');
    downloadMock.mockResolvedValue('written');
  });

  it('returns a UUID immediately and selects only imported books with a path', async () => {
    const { service, db } = createService();
    const jobChain = mockDbChain([
      { id: 1, path: '/lib/A/1', coverUrl: null },
      { id: 2, path: '/lib/A/2', coverUrl: null },
    ]);
    db.select.mockReturnValueOnce(jobChain);

    const id = service.startWriteMetadataSidecarsJob();
    expect(id).toMatch(/[0-9a-f-]{36}/);
    await waitForJob(service, id);

    const where = (jobChain.where as Mock).mock.calls[0]![0];
    const { sql } = toSQL(where);
    expect(sql).toMatch(/"books"\."status" = \?/i);
    expect(sql).toMatch(/"books"\."path" is not null/i);
    expect(service.getJob(id)?.total).toBe(2);
  });

  it('a normal imported book → OPF written + cover materialized, counted success', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: '/lib/A/1', coverUrl: 'https://x/c.png' }]));
    const id = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id);

    expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, bookId: 1, bookFolder: '/lib/A/1' }));
    expect(downloadMock).toHaveBeenCalledWith(1, '/lib/A/1', 'https://x/c.png', expect.anything(), expect.anything());
    const status = service.getJob(id);
    expect(status?.status).toBe('completed');
    expect(status?.failures).toBe(0);
    expect(status?.completed).toBe(1);
  });

  it("OPF write 'failed' → failure counted, job still completes", async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: '/lib/A/1', coverUrl: null }]));
    writeOpfMock.mockResolvedValue('failed');
    const id = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id);

    const status = service.getJob(id);
    expect(status?.status).toBe('completed');
    expect(status?.failures).toBe(1);
  });

  it("attempted cover download returning 'failed' → failure counted", async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: '/lib/A/1', coverUrl: 'https://x/c.png' }]));
    downloadMock.mockResolvedValue('failed');
    const id = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id);
    expect(service.getJob(id)?.failures).toBe(1);
  });

  it('coverUrl=null → no download attempt, counted success', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: '/lib/A/1', coverUrl: null }]));
    const id = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(service.getJob(id)?.failures).toBe(0);
  });

  it('single-file pointer (.m4b) → BOTH OPF and cover skipped, NOT a failure (F4)', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: '/audiobooks/Doctor Sleep.m4b', coverUrl: 'https://x/c.png' }]));
    const id = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id);

    expect(writeOpfMock).not.toHaveBeenCalled();
    expect(downloadMock).not.toHaveBeenCalled();
    const status = service.getJob(id);
    expect(status?.failures).toBe(0);
    expect(status?.completed).toBe(1);
  });

  it('one book failing never aborts the run (other books still processed)', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/lib/A/1', coverUrl: null },
      { id: 2, path: '/lib/A/2', coverUrl: null },
    ]));
    writeOpfMock.mockResolvedValueOnce('failed').mockResolvedValue('written');
    const id = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id);

    const status = service.getJob(id);
    expect(status?.completed).toBe(2);
    expect(status?.failures).toBe(1);
  });

  it('F5: a remote coverUrl is downloaded on the first run but a now-local one is not on the second', async () => {
    const { service, db } = createService();
    // First run sees a remote URL → download attempted (localizes the DB in production).
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: '/lib/A/1', coverUrl: 'https://x/c.png' }]));
    const id1 = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id1);
    expect(downloadMock).toHaveBeenCalledTimes(1);

    // Second run sees the now-local URL → no remote download attempted (idempotent from here on).
    downloadMock.mockClear();
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: '/lib/A/1', coverUrl: '/api/books/1/cover' }]));
    const id2 = service.startWriteMetadataSidecarsJob();
    await waitForJob(service, id2);
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent start with BULK_OP_IN_PROGRESS and reports the active job', async () => {
    const { service, db } = createService();
    // Never-resolving where() keeps the first job running so the second start collides.
    let resolveFn!: (v: unknown[]) => void;
    db.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(new Promise(r => { resolveFn = r; })),
    });
    const id = service.startWriteMetadataSidecarsJob();
    await new Promise(r => setTimeout(r, 10));

    expect(service.getActiveJob()?.jobId).toBe(id);
    expect(service.getActiveJob()?.type).toBe('write_metadata_sidecars');
    expect(() => service.startWriteMetadataSidecarsJob()).toThrow(expect.objectContaining({ code: 'BULK_OP_IN_PROGRESS' }));
    resolveFn([]);
  });
});
