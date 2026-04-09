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
import { enrichBookFromAudio } from './enrichment-utils.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { cp, mkdir, rename, rm, readdir, unlink } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { RenameService } from './rename.service.js';
import type { TaggingService } from './tagging.service.js';
import type { BookService } from './book.service.js';

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn(),
}));

vi.mock('../../core/utils/audio-processor.js', () => ({
  processAudioFiles: vi.fn(),
}));


vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    cp: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    readdir: vi.fn(),
    unlink: vi.fn(),
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
}) {
  const db = createMockDb();
  const log = createMockLogger();
  const renameService = opts?.renameService ?? makeRenameService();
  const taggingService = opts?.taggingService ?? makeTaggingService();
  const bookService = opts?.bookService ?? makeBookService();
  const settingsService = createMockSettingsService({
    library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '' },
    processing: { ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b' as const, bitrate: 128, mergeBehavior: 'always' as const, enabled: true, keepOriginalBitrate: false, maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    ...opts?.settingsOverrides,
  });
  const service = new BulkOperationService(
    inject<Db>(db),
    renameService,
    taggingService,
    settingsService,
    bookService,
    inject<FastifyBaseLogger>(log),
  );
  return { service, db, log, renameService, taggingService, bookService, settingsService };
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

describe('BulkOperationService — countConvertEligible', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns total of non-M4B eligible books', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ count: 3 }]));
    const result = await service.countConvertEligible();
    expect(result).toEqual({ total: 3 });
  });

  it('returns 0 when all books are already M4B', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ count: 0 }]));
    const result = await service.countConvertEligible();
    expect(result).toEqual({ total: 0 });
  });
});

describe('BulkOperationService — countRenameEligible', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('counts books with path not matching the template as mismatched', async () => {
    const { service, db } = createService();
    // Book1 path matches template, Book2 does not
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/Author Name/Book1', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
      { id: 2, path: '/library/Author Name/OldName', title: 'Book2', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
    ]));
    const result = await service.countRenameEligible();
    expect(result.mismatched).toBe(1);
    expect(result.alreadyMatching).toBe(1);
  });

  it('returns 0 mismatched when all books already match template', async () => {
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/Author Name/Book1', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
    ]));
    const result = await service.countRenameEligible();
    expect(result.mismatched).toBe(0);
    expect(result.alreadyMatching).toBe(1);
  });

  it('normalizes backslash separators in book.path before comparing', async () => {
    const { service, db } = createService();
    // Same path but with backslashes — should still match
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/Author Name/Book1'.split('/').join('\\'), title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
    ]));
    const result = await service.countRenameEligible();
    expect(result.alreadyMatching).toBe(1);
    expect(result.mismatched).toBe(0);
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

  it('startConvertJob returns UUID immediately', async () => {
    const { service, db } = createService();
    db.select.mockReturnValue(mockDbChain([]));
    const id = await service.startConvertJob();
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

  it('startConvertJob while retag is running throws BULK_OP_IN_PROGRESS', async () => {
    const { service, db } = createService();
    let resolveFn!: (v: unknown[]) => void;
    db.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(new Promise(r => { resolveFn = r; })),
    });
    service.startRetagJob();
    await new Promise(r => setTimeout(r, 10));
    await expect(service.startConvertJob()).rejects.toThrow(expect.objectContaining({ code: 'BULK_OP_IN_PROGRESS' }));
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

  it('startConvertJob throws FFMPEG_NOT_CONFIGURED when ffmpegPath is empty', async () => {
    const { service } = createService({
      settingsOverrides: {
        processing: { ffmpegPath: '', outputFormat: 'm4b' as const, bitrate: 128, mergeBehavior: 'always' as const, enabled: true, keepOriginalBitrate: false, maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
      },
    });
    await expect(service.startConvertJob()).rejects.toThrow(expect.objectContaining({ code: 'FFMPEG_NOT_CONFIGURED' }));
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
    // A book whose current path already matches this should be "alreadyMatching"
    const { service, db } = createService({
      settingsOverrides: {
        library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '', namingSeparator: 'period' as const, namingCase: 'upper' as const },
      },
    });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: '/library/AUTHOR.NAME/BOOK1', title: 'Book1', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
      { id: 2, path: '/library/Author Name/Book2', title: 'Book2', seriesName: null, seriesPosition: null, publishedDate: null, authorName: 'Author Name' },
    ]));
    const result = await service.countRenameEligible();
    // Book1 path matches the transformed target — already matching
    expect(result.alreadyMatching).toBe(1);
    // Book2 path uses default spacing/casing — mismatched under new settings
    expect(result.mismatched).toBe(1);
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
});

// ===== Convert batch =====

describe('BulkOperationService — convert batch', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  function setupConvertMocks() {
    (mkdir as Mock).mockResolvedValue(undefined);
    (cp as Mock).mockResolvedValue(undefined);
    (rename as Mock).mockResolvedValue(undefined);
    (rm as Mock).mockResolvedValue(undefined);
    (readdir as Mock).mockResolvedValue(['book.mp3']);
    (unlink as Mock).mockResolvedValue(undefined);
    (processAudioFiles as Mock).mockResolvedValue({
      success: true,
      outputFiles: [BOOK_PATH + '.convert-tmp/book.m4b'],
    });
    (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
  }

  it('calls processAudioFiles and enrichBookFromAudio for each eligible book', async () => {
    setupConvertMocks();
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: BOOK_PATH, title: 'Title' },
    ]));
    const id = await service.startConvertJob();
    await waitForJob(service, id);
    expect(processAudioFiles).toHaveBeenCalledWith(
      BOOK_PATH + '.convert-tmp',
      expect.objectContaining({ ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', mergeBehavior: 'always' }),
      expect.objectContaining({ title: 'Title' }),
    );
    expect(enrichBookFromAudio).toHaveBeenCalledWith(1, BOOK_PATH, expect.anything(), expect.anything(), expect.anything(), expect.anything(), '/usr/bin/ffprobe');
  });

  it('forwards sourceBitrateKbps from book.audioBitrate to processAudioFiles', async () => {
    setupConvertMocks();
    const bookService = makeBookService({ audioBitrate: 64000 });
    const { service, db } = createService({ bookService });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: BOOK_PATH, title: 'Title' },
    ]));
    const id = await service.startConvertJob();
    await waitForJob(service, id);
    expect(processAudioFiles).toHaveBeenCalledWith(
      BOOK_PATH + '.convert-tmp',
      expect.objectContaining({ sourceBitrateKbps: 64 }),
      expect.any(Object),
    );
  });

  it('passes sourceBitrateKbps as undefined when book.audioBitrate is null', async () => {
    setupConvertMocks();
    // default makeBookService has audioBitrate: null
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: BOOK_PATH, title: 'Title' },
    ]));
    const id = await service.startConvertJob();
    await waitForJob(service, id);
    expect(processAudioFiles).toHaveBeenCalledWith(
      BOOK_PATH + '.convert-tmp',
      expect.objectContaining({ sourceBitrateKbps: undefined }),
      expect.any(Object),
    );
  });

  it('emits debug log when source bitrate is lower than target', async () => {
    setupConvertMocks();
    const bookService = makeBookService({ audioBitrate: 64000 });
    const { service, db, log } = createService({ bookService });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: BOOK_PATH, title: 'Title' },
    ]));
    const id = await service.startConvertJob();
    await waitForJob(service, id);
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBitrateKbps: 64, targetBitrateKbps: 128, effectiveBitrateKbps: 64 }),
      expect.stringContaining('Capping target bitrate'),
    );
  });

  it('logs warnings from ProcessingResult when cover art degrades', async () => {
    setupConvertMocks();
    (processAudioFiles as Mock).mockResolvedValueOnce({
      success: true,
      outputFiles: [BOOK_PATH + '.convert-tmp/book.m4b'],
      warnings: ['Cover art reattach failed — output will not contain embedded cover art'],
    });
    const { service, db, log } = createService();
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: BOOK_PATH, title: 'Title' },
    ]));
    const id = await service.startConvertJob();
    await waitForJob(service, id);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Cover art reattach failed — output will not contain embedded cover art',
    );
  });

  it('counts processAudioFiles failure as failure, continues batch', async () => {
    setupConvertMocks();
    (processAudioFiles as Mock)
      .mockResolvedValueOnce({ success: false, error: 'ffmpeg failed' })
      .mockResolvedValueOnce({ success: true, outputFiles: ['/library/B.convert-tmp/B.m4b'] });
    const bookService = makeBookService();
    const { service, db } = createService({ bookService });
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, path: BOOK_PATH, title: 'A' },
      { id: 2, path: '/library/B', title: 'B' },
    ]));
    (readdir as Mock)
      .mockResolvedValueOnce(['a.mp3'])
      .mockResolvedValueOnce(['b.mp3']);
    const id = await service.startConvertJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.failures).toBe(1);
    expect(status?.completed).toBe(2);
  });

  it('returns completed status with final counts on success', async () => {
    setupConvertMocks();
    const { service, db } = createService();
    db.select.mockReturnValueOnce(mockDbChain([{ id: 1, path: BOOK_PATH, title: 'T' }]));
    const id = await service.startConvertJob();
    await waitForJob(service, id);
    const status = service.getJob(id);
    expect(status?.status).toBe('completed');
    expect(status?.failures).toBe(0);
    expect(status?.total).toBe(1);
  });
});

describe('TTL cleanup', () => {
  it('removes job from the jobs map after TTL expires', async () => {
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
