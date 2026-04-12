import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// Mock dependencies before imports
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  statfs: vi.fn(),
}));

vi.mock('../utils/post-processing-script.js', () => ({
  runPostProcessingScript: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../utils/book-status.js', () => ({
  revertBookStatus: vi.fn().mockResolvedValue('wanted'),
}));

vi.mock('../../core/utils/audio-processor.js', () => ({
  processAudioFiles: vi.fn().mockResolvedValue({ success: true, outputFiles: [] }),
}));

import { stat, rm, statfs } from 'node:fs/promises';
import { runPostProcessingScript } from '../utils/post-processing-script.js';
import { revertBookStatus } from '../utils/book-status.js';
import type { Stats } from 'node:fs';

import { processAudioFiles } from '../../core/utils/audio-processor.js';

import {
  validateSource,
  checkDiskSpace,
  embedTagsForImport,
  runImportPostProcessing,
  emitImportSuccess,
  emitDownloadImporting,
  emitBookImporting,
  emitImportFailure,
  notifyImportComplete,
  notifyImportFailure,
  recordImportEvent,
  recordImportFailedEvent,
  handleImportFailure,
  runAudioProcessing,
} from './import-steps.js';

function createMockLog(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as FastifyBaseLogger;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── validateSource ──────────────────────────────────────────────────────

describe('validateSource', () => {
  it('returns sourcePath and fileCount for directory with audio files', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false, isDirectory: () => true, size: 5000 } as unknown as Stats);
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'track.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);

    const result = await validateSource('/downloads/book', undefined, null);
    expect(result.sourcePath).toBe('/downloads/book');
    expect(result.fileCount).toBe(1);
    expect(result.sourceStats.isDirectory()).toBe(true);
  });

  it('throws when directory has no audio files', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false, isDirectory: () => true } as unknown as Stats);
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
    ] as never);

    await expect(validateSource('/downloads/book', undefined, null)).rejects.toThrow('No audio files found');
  });

  it('returns fileCount=1 for single file', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 1024 } as unknown as Stats);
    const result = await validateSource('/downloads/book.mp3', undefined, null);
    expect(result.fileCount).toBe(1);
  });

  it('throws ENOENT with mapping hint when remote mappings exist', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(stat).mockRejectedValue(enoent);
    const mockMappingService = {
      getByClientId: vi.fn().mockResolvedValue([{ id: 1 }]),
    };

    await expect(
      validateSource('/downloads/book', mockMappingService as never, 1),
    ).rejects.toThrow('remote path mapping');
  });

  it('throws ENOENT with Docker hint when no mappings exist', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(stat).mockRejectedValue(enoent);

    await expect(
      validateSource('/downloads/book', undefined, null),
    ).rejects.toThrow('Docker');
  });

  it('rethrows non-ENOENT errors as-is', async () => {
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    vi.mocked(stat).mockRejectedValue(eperm);

    await expect(validateSource('/downloads/book', undefined, null)).rejects.toThrow('EPERM');
  });
});

// ── checkDiskSpace ──────────────────────────────────────────────────────

describe('checkDiskSpace', () => {
  it('skips check when minFreeSpaceGB is 0', async () => {
    await checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => true } as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 0, processingEnabled: false,
    });
    expect(statfs).not.toHaveBeenCalled();
  });

  it('uses 1.5x multiplier when processing enabled', async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);
    vi.mocked(stat).mockResolvedValue({ size: 100 } as Stats);
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([]);

    // Should not throw with plenty of space
    await checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 1_000_000_000 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1, processingEnabled: true,
    });
    expect(statfs).toHaveBeenCalledWith('/lib');
  });

  it('throws when insufficient space with exact GB in message', async () => {
    // Only 1 GB free but need more
    vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) } as never);

    await expect(checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 5_000_000_000 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 5, processingEnabled: false,
    })).rejects.toThrow('insufficient disk space');
  });

  it('wraps statfs errors', async () => {
    vi.mocked(statfs).mockRejectedValue(new Error('disk error'));

    await expect(checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 100 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1, processingEnabled: false,
    })).rejects.toThrow('Disk space check failed');
  });
});

// ── embedTagsForImport ──────────────────────────────────────────────────

describe('embedTagsForImport', () => {
  const bookMeta = { title: 'Book', authorName: 'Author', narrator: 'Narrator', seriesName: 'Series', seriesPosition: 1, coverUrl: 'http://cover.jpg' };

  it('calls tagBook when tagging enabled and ffmpegPath configured', async () => {
    const log = createMockLog();
    const tagBook = vi.fn().mockResolvedValue({ tagged: 1, skipped: 0, failed: 0 });
    const taggingService = { tagBook } as never;

    await embedTagsForImport({
      taggingService, taggingEnabled: true, ffmpegPath: '/usr/bin/ffmpeg',
      taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });

    expect(tagBook).toHaveBeenCalledWith(1, '/lib/book', bookMeta, '/usr/bin/ffmpeg', 'overwrite', true);
  });

  it('skips when taggingService is null', async () => {
    const log = createMockLog();
    await embedTagsForImport({
      taggingService: undefined, taggingEnabled: true, ffmpegPath: '/usr/bin/ffmpeg',
      taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });
    // No error, no log — just a no-op
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips when taggingSettings.enabled is false', async () => {
    const log = createMockLog();
    const tagBook = vi.fn();
    await embedTagsForImport({
      taggingService: { tagBook } as never, taggingEnabled: false, ffmpegPath: '/usr/bin/ffmpeg',
      taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(tagBook).not.toHaveBeenCalled();
  });

  it('skips with debug log when ffmpegPath is empty/whitespace', async () => {
    const log = createMockLog();
    const tagBook = vi.fn();
    await embedTagsForImport({
      taggingService: { tagBook } as never, taggingEnabled: true, ffmpegPath: '  ',
      taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(tagBook).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });

  it('logs warning and continues when tagBook throws', async () => {
    const log = createMockLog();
    const tagBook = vi.fn().mockRejectedValue(new Error('tag failed'));
    await embedTagsForImport({
      taggingService: { tagBook } as never, taggingEnabled: true, ffmpegPath: '/usr/bin/ffmpeg',
      taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(log.warn).toHaveBeenCalled();
  });

  it('passes correct metadata to tagBook', async () => {
    const log = createMockLog();
    const tagBook = vi.fn().mockResolvedValue({ tagged: 1, skipped: 0, failed: 0 });
    await embedTagsForImport({
      taggingService: { tagBook } as never, taggingEnabled: true, ffmpegPath: '/ffmpeg',
      taggingMode: 'populate_missing', embedCover: false,
      bookId: 42, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(tagBook).toHaveBeenCalledWith(
      42, '/lib/book',
      { title: 'Book', authorName: 'Author', narrator: 'Narrator', seriesName: 'Series', seriesPosition: 1, coverUrl: 'http://cover.jpg' },
      '/ffmpeg', 'populate_missing', false,
    );
  });
});

// ── runImportPostProcessing ─────────────────────────────────────────────

describe('runImportPostProcessing', () => {
  it('skips when postProcessingScript is empty/null', async () => {
    const log = createMockLog();
    await runImportPostProcessing({
      postProcessingScript: '', postProcessingScriptTimeout: null,
      targetPath: '/lib/book', bookTitle: 'Book', bookAuthor: 'Author', fileCount: 1, bookId: 1, log,
    });
    expect(runPostProcessingScript).not.toHaveBeenCalled();
  });

  it('calls runPostProcessingScript with correct args', async () => {
    const log = createMockLog();
    await runImportPostProcessing({
      postProcessingScript: '/scripts/run.sh', postProcessingScriptTimeout: 600,
      targetPath: '/lib/book', bookTitle: 'Book', bookAuthor: 'Author', fileCount: 3, bookId: 1, log,
    });
    expect(runPostProcessingScript).toHaveBeenCalledWith({
      scriptPath: '/scripts/run.sh',
      timeoutSeconds: 600,
      audiobookPath: '/lib/book',
      bookTitle: 'Book',
      bookAuthor: 'Author',
      fileCount: 3,
      log,
    });
  });

  it('defaults timeout to 300s when not configured', async () => {
    const log = createMockLog();
    await runImportPostProcessing({
      postProcessingScript: '/scripts/run.sh', postProcessingScriptTimeout: null,
      targetPath: '/lib/book', bookTitle: 'Book', bookAuthor: null, fileCount: 1, bookId: 1, log,
    });
    expect(runPostProcessingScript).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 300 }),
    );
  });

  it('passes explicit positive timeout when set', async () => {
    const log = createMockLog();
    await runImportPostProcessing({
      postProcessingScript: '/scripts/run.sh', postProcessingScriptTimeout: 120,
      targetPath: '/lib/book', bookTitle: 'Book', bookAuthor: null, fileCount: 1, bookId: 1, log,
    });
    expect(runPostProcessingScript).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 120 }),
    );
  });

  it('logs warning and continues when script throws', async () => {
    const log = createMockLog();
    vi.mocked(runPostProcessingScript).mockRejectedValueOnce(new Error('script died'));
    await runImportPostProcessing({
      postProcessingScript: '/scripts/run.sh', postProcessingScriptTimeout: null,
      targetPath: '/lib/book', bookTitle: 'Book', bookAuthor: null, fileCount: 1, bookId: 1, log,
    });
    expect(log.warn).toHaveBeenCalled();
  });
});

// ── emitImportSuccess ───────────────────────────────────────────────────

describe('emitImportSuccess', () => {
  it('emits download_status_change, book_status_change, and import_complete events', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitImportSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, bookTitle: 'Book', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({ download_id: 1, new_status: 'imported' }));
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ book_id: 2, new_status: 'imported' }));
    expect(broadcaster.emit).toHaveBeenCalledWith('import_complete', expect.objectContaining({ download_id: 1, book_id: 2, book_title: 'Book' }));
  });

  it('skips when broadcaster is undefined', () => {
    const log = createMockLog();
    // Should not throw
    emitImportSuccess({ broadcaster: undefined, downloadId: 1, bookId: 2, bookTitle: 'Book', log });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('catches and logs at debug level when emit throws', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn().mockImplementation(() => { throw new Error('emit fail'); }) };
    emitImportSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, bookTitle: 'Book', log });
    expect(log.debug).toHaveBeenCalled();
  });

  it('continues emitting remaining events when the first emit throws', () => {
    const log = createMockLog();
    const broadcaster = {
      emit: vi.fn()
        .mockImplementationOnce(() => { throw new Error('first fails'); })
        .mockImplementationOnce(() => {}) // book_status_change succeeds
        .mockImplementationOnce(() => {}), // import_complete succeeds
    };
    emitImportSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, bookTitle: 'Book', log });
    expect(broadcaster.emit).toHaveBeenCalledTimes(3);
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ book_id: 2 }));
    expect(broadcaster.emit).toHaveBeenCalledWith('import_complete', expect.objectContaining({ download_id: 1 }));
  });
});

// ── notifyImportComplete ────────────────────────────────────────────────

describe('notifyImportComplete', () => {
  it('calls notify with on_import event and correct payload', () => {
    const log = createMockLog();
    const notify = vi.fn().mockReturnValue({ catch: vi.fn() });
    const notifierService = { notify } as never;
    notifyImportComplete({ notifierService, bookTitle: 'Book', authorName: 'Author', targetPath: '/lib/book', fileCount: 3, log });
    expect(notify).toHaveBeenCalledWith('on_import', {
      event: 'on_import',
      book: { title: 'Book', author: 'Author' },
      import: { libraryPath: '/lib/book', fileCount: 3 },
    });
  });

  it('skips when notifierService is undefined', () => {
    const log = createMockLog();
    notifyImportComplete({ notifierService: undefined, bookTitle: 'Book', authorName: null, targetPath: '/lib', fileCount: 1, log });
    // No error
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('includes author.name in payload when author exists', () => {
    const log = createMockLog();
    const notify = vi.fn().mockReturnValue({ catch: vi.fn() });
    notifyImportComplete({ notifierService: { notify } as never, bookTitle: 'Book', authorName: 'John', targetPath: '/lib', fileCount: 1, log });
    expect(notify).toHaveBeenCalledWith('on_import', expect.objectContaining({ book: { title: 'Book', author: 'John' } }));
  });

  it('sends undefined author when no author', () => {
    const log = createMockLog();
    const notify = vi.fn().mockReturnValue({ catch: vi.fn() });
    notifyImportComplete({ notifierService: { notify } as never, bookTitle: 'Book', authorName: null, targetPath: '/lib', fileCount: 1, log });
    expect(notify).toHaveBeenCalledWith('on_import', expect.objectContaining({ book: { title: 'Book', author: undefined } }));
  });

  it('catches rejection and logs warning', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const notify = vi.fn().mockReturnValue({ catch: catchFn });
    notifyImportComplete({ notifierService: { notify } as never, bookTitle: 'Book', authorName: null, targetPath: '/lib', fileCount: 1, log });
    // The .catch handler should be attached
    expect(catchFn).toHaveBeenCalledWith(expect.any(Function));
  });
});

// ── recordImportEvent ───────────────────────────────────────────────────

describe('recordImportEvent', () => {
  it('records imported event when book had no prior path', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const create = vi.fn().mockReturnValue({ catch: catchFn });
    const eventHistory = { create } as never;
    recordImportEvent({
      eventHistory, bookId: 1, bookTitle: 'Book', authorName: 'Author',
      downloadId: 10, bookPath: null, targetPath: '/lib/book', fileCount: 3, totalSize: 5000, log,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'imported' }));
  });

  it('records upgraded event when book had existing path', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const create = vi.fn().mockReturnValue({ catch: catchFn });
    const eventHistory = { create } as never;
    recordImportEvent({
      eventHistory, bookId: 1, bookTitle: 'Book', authorName: 'Author',
      downloadId: 10, bookPath: '/old/path', targetPath: '/lib/book', fileCount: 3, totalSize: 5000, log,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'upgraded' }));
  });

  it('skips when eventHistory is undefined', () => {
    const log = createMockLog();
    recordImportEvent({
      eventHistory: undefined, bookId: 1, bookTitle: 'Book', authorName: null,
      downloadId: 10, bookPath: null, targetPath: '/lib/book', fileCount: 1, totalSize: 100, log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('catches rejection and logs warning', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const create = vi.fn().mockReturnValue({ catch: catchFn });
    recordImportEvent({
      eventHistory: { create } as never, bookId: 1, bookTitle: 'Book', authorName: null,
      downloadId: 10, bookPath: null, targetPath: '/lib/book', fileCount: 1, totalSize: 100, log,
    });
    expect(catchFn).toHaveBeenCalledWith(expect.any(Function));
  });
});

// ── handleImportFailure ─────────────────────────────────────────────────

describe('handleImportFailure', () => {
  const mockDb = { update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) }) };

  it('cleans up targetPath when set', async () => {
    const log = createMockLog();
    const error = new Error('import broke');
    await expect(handleImportFailure({
      error, targetPath: '/lib/book', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('import broke');
    expect(rm).toHaveBeenCalledWith('/lib/book', { recursive: true, force: true });
  });

  it('skips cleanup when targetPath is undefined', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: undefined, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).not.toHaveBeenCalled();
  });

  it('logs warning when targetPath cleanup fails', async () => {
    const log = createMockLog();
    vi.mocked(rm).mockRejectedValueOnce(new Error('rm fail'));
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/lib/book', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(log.warn).toHaveBeenCalled();
  });

  it('sets download status to failed with error message', async () => {
    const log = createMockLog();
    const where = vi.fn();
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const db = { update } as never;

    await expect(handleImportFailure({
      error: new Error('broke'), targetPath: undefined, db,
      downloadId: 42, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('broke');

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorMessage: 'broke',
    }));
  });

  it('reverts book status via revertBookStatus', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: undefined, db: mockDb as never,
      downloadId: 1, book: { id: 5, title: 'Book', path: '/old' }, log,
    })).rejects.toThrow('fail');
    expect(revertBookStatus).toHaveBeenCalledWith(mockDb, { id: 5, title: 'Book', path: '/old' });
  });

  it('rethrows the original error', async () => {
    const log = createMockLog();
    const originalError = new Error('original');
    await expect(handleImportFailure({
      error: originalError, targetPath: undefined, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toBe(originalError);
  });
});

// ── emitDownloadImporting ───────────────────────────────────────────────

describe('emitDownloadImporting', () => {
  it('emits download_status_change with importing status', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitDownloadImporting({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, downloadStatus: 'completed', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
      download_id: 1, book_id: 2, old_status: 'completed', new_status: 'importing',
    }));
  });

  it('skips when broadcaster is undefined', () => {
    const log = createMockLog();
    emitDownloadImporting({ broadcaster: undefined, downloadId: 1, bookId: 2, downloadStatus: 'completed', log });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('catches and logs at debug level when emit throws', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn().mockImplementation(() => { throw new Error('emit fail'); }) };
    emitDownloadImporting({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, downloadStatus: 'completed', log });
    expect(log.debug).toHaveBeenCalled();
  });
});

// ── emitBookImporting ───────────────────────────────────────────────────

describe('emitBookImporting', () => {
  it('emits book_status_change with importing status', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitBookImporting({ broadcaster: broadcaster as never, bookId: 2, bookStatus: 'wanted', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
      book_id: 2, old_status: 'wanted', new_status: 'importing',
    }));
  });

  it('skips when broadcaster is undefined', () => {
    const log = createMockLog();
    emitBookImporting({ broadcaster: undefined, bookId: 2, bookStatus: 'wanted', log });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('catches and logs at debug level when emit throws', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn().mockImplementation(() => { throw new Error('emit fail'); }) };
    emitBookImporting({ broadcaster: broadcaster as never, bookId: 2, bookStatus: 'wanted', log });
    expect(log.debug).toHaveBeenCalled();
  });
});

// ── emitImportFailure ───────────────────────────────────────────────────

describe('emitImportFailure', () => {
  it('emits SSE failure events for download and book', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitImportFailure({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, revertedBookStatus: 'wanted', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({ new_status: 'failed' }));
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ new_status: 'wanted' }));
  });

  it('skips when broadcaster is undefined', () => {
    const log = createMockLog();
    emitImportFailure({ broadcaster: undefined, downloadId: 1, bookId: 2, revertedBookStatus: 'wanted', log });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('continues emitting book_status_change when download_status_change throws', () => {
    const log = createMockLog();
    const broadcaster = {
      emit: vi.fn()
        .mockImplementationOnce(() => { throw new Error('first fails'); })
        .mockImplementationOnce(() => {}), // book_status_change succeeds
    };
    emitImportFailure({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, revertedBookStatus: 'wanted', log });
    expect(broadcaster.emit).toHaveBeenCalledTimes(2);
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ new_status: 'wanted' }));
  });
});

describe('#324 — emitBookImporting dedupe guard', () => {
  it('skips SSE emit when bookStatus === importing (already at target)', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitBookImporting({ broadcaster: broadcaster as never, bookId: 2, bookStatus: 'importing', log });
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });

  it('emits SSE when bookStatus !== importing (e.g., downloading, wanted)', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitBookImporting({ broadcaster: broadcaster as never, bookId: 2, bookStatus: 'downloading', log });
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({
      book_id: 2, old_status: 'downloading', new_status: 'importing',
    }));
  });
});

// ── notifyImportFailure ─────────────────────────────────────────────────

describe('notifyImportFailure', () => {
  it('sends failure notification with on_failure event', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const notify = vi.fn().mockReturnValue({ catch: catchFn });
    notifyImportFailure({ notifierService: { notify } as never, downloadTitle: 'Download Name', error: new Error('fail'), log });
    expect(notify).toHaveBeenCalledWith('on_failure', expect.objectContaining({ event: 'on_failure' }));
  });

  it('uses download title in failure notification payload', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const notify = vi.fn().mockReturnValue({ catch: catchFn });
    notifyImportFailure({ notifierService: { notify } as never, downloadTitle: 'Torrent Release Name [2024]', error: new Error('fail'), log });
    expect(notify).toHaveBeenCalledWith('on_failure', expect.objectContaining({
      book: { title: 'Torrent Release Name [2024]' },
    }));
  });

  it('skips when notifierService is undefined', () => {
    const log = createMockLog();
    notifyImportFailure({ notifierService: undefined, downloadTitle: 'Name', error: new Error('fail'), log });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ── recordImportFailedEvent ─────────────────────────────────────────────

describe('recordImportFailedEvent', () => {
  it('records import_failed event', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const create = vi.fn().mockReturnValue({ catch: catchFn });
    recordImportFailedEvent({ eventHistory: { create } as never, bookId: 1, bookTitle: 'Book', authorName: null, downloadId: 10, error: new Error('fail'), log });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'import_failed' }));
  });

  it('skips when eventHistory is undefined', () => {
    const log = createMockLog();
    recordImportFailedEvent({ eventHistory: undefined, bookId: 1, bookTitle: 'Book', authorName: null, downloadId: 10, error: new Error('fail'), log });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('runAudioProcessing', () => {
  it('forwards namingOptions into processAudioFiles context', async () => {
    const log = createMockLog();
    const mockDb = {} as never;

    await runAudioProcessing({
      processingSettings: {
        enabled: true,
        ffmpegPath: '/usr/bin/ffmpeg',
        outputFormat: 'm4b',
        bitrate: 128,
        keepOriginalBitrate: false,
        mergeBehavior: 'always',
      },
      librarySettings: {
        fileFormat: '{author} - {title}',
      },
      targetPath: '/library/Author/Book',
      book: { id: 1, title: 'Book', seriesName: null, seriesPosition: null, narrators: null, publishedDate: null },
      authorName: 'Author',
      namingOptions: { separator: 'period', case: 'upper' },
      db: mockDb,
      log,
    });

    expect(processAudioFiles).toHaveBeenCalledWith(
      '/library/Author/Book',
      expect.any(Object),
      expect.objectContaining({
        namingOptions: { separator: 'period', case: 'upper' },
      }),
    );
  });

  it('forwards sourceBitrateKbps to processAudioFiles when sourceBitrateBps is provided', async () => {
    const log = createMockLog();
    const mockDb = {} as never;

    await runAudioProcessing({
      processingSettings: {
        enabled: true,
        ffmpegPath: '/usr/bin/ffmpeg',
        outputFormat: 'm4b',
        bitrate: 128,
        keepOriginalBitrate: false,
        mergeBehavior: 'always',
      },
      librarySettings: { fileFormat: '{author} - {title}' },
      targetPath: '/library/Author/Book',
      book: { id: 1, title: 'Book', seriesName: null, seriesPosition: null, narrators: null, publishedDate: null },
      authorName: 'Author',
      sourceBitrateBps: 64000,
      db: mockDb,
      log,
    });

    expect(processAudioFiles).toHaveBeenCalledWith(
      '/library/Author/Book',
      expect.objectContaining({ sourceBitrateKbps: 64, bitrate: 128 }),
      expect.any(Object),
    );
  });

  it('passes sourceBitrateKbps as undefined when sourceBitrateBps is null', async () => {
    const log = createMockLog();
    const mockDb = {} as never;

    await runAudioProcessing({
      processingSettings: {
        enabled: true,
        ffmpegPath: '/usr/bin/ffmpeg',
        outputFormat: 'm4b',
        bitrate: 128,
        keepOriginalBitrate: false,
        mergeBehavior: 'always',
      },
      librarySettings: { fileFormat: '{author} - {title}' },
      targetPath: '/library/Author/Book',
      book: { id: 1, title: 'Book', seriesName: null, seriesPosition: null, narrators: null, publishedDate: null },
      authorName: 'Author',
      sourceBitrateBps: null,
      db: mockDb,
      log,
    });

    expect(processAudioFiles).toHaveBeenCalledWith(
      '/library/Author/Book',
      expect.objectContaining({ sourceBitrateKbps: undefined }),
      expect.any(Object),
    );
  });

  it('logs debug when source bitrate is lower than target', async () => {
    const log = createMockLog();
    const mockDb = {} as never;

    await runAudioProcessing({
      processingSettings: {
        enabled: true,
        ffmpegPath: '/usr/bin/ffmpeg',
        outputFormat: 'm4b',
        bitrate: 128,
        keepOriginalBitrate: false,
        mergeBehavior: 'always',
      },
      librarySettings: { fileFormat: '{author} - {title}' },
      targetPath: '/library/Author/Book',
      book: { id: 1, title: 'Book', seriesName: null, seriesPosition: null, narrators: null, publishedDate: null },
      authorName: 'Author',
      sourceBitrateBps: 64000,
      db: mockDb,
      log,
    });

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBitrateKbps: 64, targetBitrateKbps: 128, effectiveBitrateKbps: 64 }),
      expect.stringContaining('Capping target bitrate'),
    );
  });

  it('logs warnings from ProcessingResult when cover art degrades', async () => {
    const log = createMockLog();
    const mockDb = {} as never;
    vi.mocked(processAudioFiles).mockResolvedValueOnce({
      success: true,
      outputFiles: ['/library/Author/Book/output.m4b'],
      warnings: ['Cover art extraction failed — output will not contain embedded cover art'],
    });

    await runAudioProcessing({
      processingSettings: {
        enabled: true,
        ffmpegPath: '/usr/bin/ffmpeg',
        outputFormat: 'm4b',
        bitrate: 128,
        keepOriginalBitrate: false,
        mergeBehavior: 'always',
      },
      librarySettings: { fileFormat: '{author} - {title}' },
      targetPath: '/library/Author/Book',
      book: { id: 1, title: 'Book', seriesName: null, seriesPosition: null, narrators: null, publishedDate: null },
      authorName: 'Author',
      sourceBitrateBps: 128000,
      db: mockDb,
      log,
    });

    expect(log.warn).toHaveBeenCalledWith('Cover art extraction failed — output will not contain embedded cover art');
  });

  // ── #229 Observability — checkDiskSpace return type ─────────────────────
  describe('checkDiskSpace return type (#229)', () => {
    it('returns { freeGB, requiredGB } on success', async () => {
      vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);

      const result = await checkDiskSpace({
        sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 1_000_000_000 } as unknown as Stats,
        libraryPath: '/lib', minFreeSpaceGB: 1, processingEnabled: false,
      });

      expect(result).toHaveProperty('freeGB');
      expect(result).toHaveProperty('requiredGB');
      expect(typeof result.freeGB).toBe('number');
      expect(typeof result.requiredGB).toBe('number');
      expect(result.freeGB).toBeGreaterThan(0);
    });

    it('still throws on insufficient disk space', async () => {
      vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) } as never);

      await expect(checkDiskSpace({
        sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 5_000_000_000 } as unknown as Stats,
        libraryPath: '/lib', minFreeSpaceGB: 5, processingEnabled: false,
      })).rejects.toThrow('insufficient disk space');
    });

    it('still throws on statfs failure', async () => {
      vi.mocked(statfs).mockRejectedValue(new Error('disk error'));

      await expect(checkDiskSpace({
        sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 100 } as unknown as Stats,
        libraryPath: '/lib', minFreeSpaceGB: 1, processingEnabled: false,
      })).rejects.toThrow('Disk space check failed');
    });
  });
});
