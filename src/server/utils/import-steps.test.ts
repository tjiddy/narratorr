import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { deriveImportSiblings } from '../utils/import-sibling-paths.js';
import { inject, mockDbChain } from '../__tests__/helpers.js';
import { claimLockKey } from '../utils/claim-lock.js';
import { hasPendingPathWrite } from '../utils/path-write-lock.js';
import type { Db } from '@db/index.js';

// Mutable arrow mock survives clearAllMocks; flip false for the unavailable test.
const { ffmpegState, mutagenState } = vi.hoisted(() => ({
  ffmpegState: { resolves: true },
  mutagenState: { resolves: true },
}));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/audio-processor.js')>();
  return { ...actual, resolveFfmpegPath: () => Promise.resolve(ffmpegState.resolves ? '/usr/bin/ffmpeg' : null) };
});
vi.mock('@core/utils/mutagen-resolver.js', () => ({
  resolveMutagenPython: () => Promise.resolve(mutagenState.resolves ? '/usr/bin/python3' : null),
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  // Default to a non-symlink directory; symlink behavior has dedicated coverage.
  lstat: vi.fn(),
  readdir: vi.fn(),
  // Default to foreign OPF content unless a test marks it as managed.
  readFile: vi.fn().mockResolvedValue('<?xml version="1.0"?><package><metadata><dc:title>foreign</dc:title></metadata></package>'),
  rm: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  // Identity realpath keeps ordinary paths lexically contained.
  realpath: vi.fn().mockImplementation(async (p: unknown) => String(p)),
  statfs: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue({
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../utils/post-processing-script.js', () => ({
  runPostProcessingScript: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../utils/book-status.js', () => ({
  revertBookStatus: vi.fn().mockResolvedValue('wanted'),
}));

vi.mock('./import-helpers.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getPathSize: vi.fn().mockResolvedValue(1000),
    getAudioPathSize: vi.fn().mockResolvedValue(1000),
  };
});

import { stat, lstat, rm, rmdir, statfs, readdir, mkdir, rename, writeFile, open, realpath } from 'node:fs/promises';
import { runPostProcessingScript } from '../utils/post-processing-script.js';
import { revertBookStatus } from '../utils/book-status.js';
import { getPathSize, getAudioPathSize, ContentFailureError } from './import-helpers.js';
import { PathOutsideLibraryError } from './paths.js';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import {
  validateSource,
  copyToLibrary,
  checkDiskSpace,
  verifyCopy,
  embedTagsForImport,
  runImportPostProcessing,
  emitImportStatusSuccess,
  emitDownloadImporting,
  emitBookImporting,
  emitImportFailure,
  notifyImportComplete,
  notifyImportFailure,
  recordImportEvent,
  recordImportFailedEvent,
  handleImportFailure,
  isContentFailure,
  cleanupOldBookPath,
  prepareImportSiblings,
  commitStagedImport,
  stagedAudioReplace,
  BackupRecoveryError,
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
  // clearAllMocks preserves implementations, and the retry cases below arm PERSISTENT rejections
  // (a Once queue drains on removeTree's second attempt). Restore the factory default every test.
  vi.mocked(rm).mockReset();
  vi.mocked(rm).mockResolvedValue(undefined);
});

/**
 * Removals now go through `removeTree`, which retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM four
 * times over 600 ms of its OWN backoff. Tests that arm one of those codes would pay that in real
 * time; redirect the helper's `setTimeout` so the full ladder still runs, instantly.
 */
function collapseRemoveTreeBackoff(): void {
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
    realSetTimeout(fn, 0)) as typeof globalThis.setTimeout);
  onTestFinished(() => { spy.mockRestore(); });
}

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

  it('throws a typed ContentFailureError with byte-identical message when directory has no audio files (#1346)', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false, isDirectory: () => true } as unknown as Stats);
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
    ] as never);

    await expect(validateSource('/downloads/book', undefined, null)).rejects.toBeInstanceOf(ContentFailureError);
    await expect(validateSource('/downloads/book', undefined, null)).rejects.toThrow('No audio files found in /downloads/book');
  });

  it('returns fileCount=1 for single file', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 1024 } as unknown as Stats);
    const result = await validateSource('/downloads/book.mp3', undefined, null);
    expect(result.fileCount).toBe(1);
  });

  it('#1852 F28: rejects a direct hidden audio file before assigning fileCount', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 1024 } as unknown as Stats);
    await expect(validateSource('/downloads/.x.mp3', undefined, null)).rejects.toBeInstanceOf(ContentFailureError);
    await expect(validateSource('/downloads/.x.mp3', undefined, null)).rejects.toThrow(/hidden/);
  });

  it('#1852 F28: rejects a direct non-audio (unsupported) file before disk work', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false, size: 1024 } as unknown as Stats);
    await expect(validateSource('/downloads/book.txt', undefined, null)).rejects.toBeInstanceOf(ContentFailureError);
    await expect(validateSource('/downloads/book.txt', undefined, null)).rejects.toThrow('not a supported audio format');
  });

  it('#1852 F38: rejects a hidden source DIRECTORY before contains/count/disk work', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false, isDirectory: () => true } as unknown as Stats);
    // Hidden-root rejection must precede traversal; readdir is intentionally unmocked.
    await expect(validateSource('/downloads/.incomplete', undefined, null)).rejects.toBeInstanceOf(ContentFailureError);
    await expect(validateSource('/downloads/.incomplete', undefined, null)).rejects.toThrow(/hidden/);
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

describe('copyToLibrary', () => {
  it('throws a typed ContentFailureError with byte-identical message for a non-audio source file (#1346)', async () => {
    const args = {
      sourcePath: '/downloads/book.txt',
      targetPath: '/lib/book',
      sourceStats: { isDirectory: () => false, isFile: () => true, size: 100 } as unknown as Stats,
      log: createMockLog(),
    };

    await expect(copyToLibrary(args)).rejects.toBeInstanceOf(ContentFailureError);
    await expect(copyToLibrary(args)).rejects.toThrow('Source file is not a supported audio format: book.txt');
  });
});

describe('checkDiskSpace', () => {
  it('skips check when minFreeSpaceGB is 0', async () => {
    await checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => true } as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 0,
    });
    expect(statfs).not.toHaveBeenCalled();
  });

  it('uses 1x source size for disk space estimation', async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);
    vi.mocked(stat).mockResolvedValue({ size: 100 } as Stats);
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([]);

    await checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 1_000_000_000 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1,
    });
    expect(statfs).toHaveBeenCalledWith('/lib');
  });

  it('throws when insufficient space with exact GB in message', async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) } as never);

    await expect(checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 5_000_000_000 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 5,
    })).rejects.toThrow('insufficient disk space');
  });

  it('wraps statfs errors', async () => {
    vi.mocked(statfs).mockRejectedValue(new Error('disk error'));

    await expect(checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 100 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1,
    })).rejects.toThrow('Disk space check failed');
  });

  it('#1852 F40: a directory source sizes only visible bytes and never traverses a .hidden/ subtree', async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);
    // An unreadable hidden subtree proves visible-size traversal never enters it.
    vi.mocked(stat).mockImplementation(async (p: unknown) =>
      String(p).endsWith('/src')
        ? ({ isFile: () => false, isDirectory: () => true } as never)
        : ({ isFile: () => true, isDirectory: () => false, size: 100 } as never));
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('/src')) {
        return [
          { name: 'real.mp3', isFile: () => true, isDirectory: () => false },
          { name: '.hidden', isFile: () => false, isDirectory: () => true },
        ] as never;
      }
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    await expect(checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => true } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1,
    })).resolves.toBeDefined();
    expect(statfs).toHaveBeenCalledWith('/lib');
  });
});

describe('embedTagsForImport', () => {
  // Extra bibliographic fields exercise end-to-end propagation into tagBook.
  const bookMeta = { title: 'Book', authorName: 'Author', narrator: 'Narrator', seriesName: 'Series', seriesPosition: 1, publisher: 'Tor Books', coverUrl: 'http://cover.jpg' };

  it('calls tagBook with the resolved interpreter when tagging is enabled', async () => {
    const log = createMockLog();
    const tagBook = vi.fn().mockResolvedValue({ tagged: 1, skipped: 0, failed: 0 });
    const taggingService = { tagBook } as never;

    await embedTagsForImport({
      taggingService, taggingEnabled: true, taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });

    expect(tagBook).toHaveBeenCalledWith(1, '/lib/book', bookMeta, '/usr/bin/python3', 'overwrite', true);
  });

  it('skips when taggingService is null', async () => {
    const log = createMockLog();
    await embedTagsForImport({
      taggingService: undefined, taggingEnabled: true, taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips when taggingSettings.enabled is false', async () => {
    const log = createMockLog();
    const tagBook = vi.fn();
    await embedTagsForImport({
      taggingService: { tagBook } as never, taggingEnabled: false, taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(tagBook).not.toHaveBeenCalled();
  });

  // AC13: an already-committed import must never fail because the tag writer is missing.
  it('logs and skips without failing the import when no mutagen interpreter is detected', async () => {
    mutagenState.resolves = false;
    try {
      const log = createMockLog();
      const tagBook = vi.fn();
      await expect(embedTagsForImport({
        taggingService: { tagBook } as never, taggingEnabled: true, taggingMode: 'overwrite', embedCover: true,
        bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
      })).resolves.toBeUndefined();
      expect(tagBook).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith({ bookId: 1 }, expect.stringContaining('mutagen'));
    } finally {
      mutagenState.resolves = true;
    }
  });

  it('still embeds tags when ffmpeg is absent but mutagen is present (AC14)', async () => {
    ffmpegState.resolves = false;
    try {
      const log = createMockLog();
      const tagBook = vi.fn().mockResolvedValue({ tagged: 1, skipped: 0, failed: 0 });
      await embedTagsForImport({
        taggingService: { tagBook } as never, taggingEnabled: true, taggingMode: 'overwrite', embedCover: true,
        bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
      });
      expect(tagBook).toHaveBeenCalledWith(1, '/lib/book', bookMeta, '/usr/bin/python3', 'overwrite', true);
    } finally {
      ffmpegState.resolves = true;
    }
  });

  it('logs warning and continues when tagBook throws', async () => {
    const log = createMockLog();
    const tagBook = vi.fn().mockRejectedValue(new Error('tag failed'));
    await embedTagsForImport({
      taggingService: { tagBook } as never, taggingEnabled: true, taggingMode: 'overwrite', embedCover: true,
      bookId: 1, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(log.warn).toHaveBeenCalled();
  });

  it('passes correct metadata to tagBook', async () => {
    const log = createMockLog();
    const tagBook = vi.fn().mockResolvedValue({ tagged: 1, skipped: 0, failed: 0 });
    await embedTagsForImport({
      taggingService: { tagBook } as never, taggingEnabled: true, taggingMode: 'populate_missing', embedCover: false,
      bookId: 42, targetPath: '/lib/book', book: bookMeta, log,
    });
    expect(tagBook).toHaveBeenCalledWith(
      42, '/lib/book',
      { title: 'Book', authorName: 'Author', narrator: 'Narrator', seriesName: 'Series', seriesPosition: 1, publisher: 'Tor Books', coverUrl: 'http://cover.jpg' },
      '/usr/bin/python3', 'populate_missing', false,
    );
  });
});

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

describe('emitImportStatusSuccess', () => {
  it('emits download_status_change and book_status_change events', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitImportStatusSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({ download_id: 1, new_status: 'imported' }));
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ book_id: 2, new_status: 'imported' }));
  });

  // ImportQueueWorker owns job-lifecycle completion.
  it('does NOT emit import_complete (job-lifecycle event owned by the queue worker)', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitImportStatusSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, log });
    const completeCalls = broadcaster.emit.mock.calls.filter(([eventName]) => eventName === 'import_complete');
    expect(completeCalls).toHaveLength(0);
  });

  it('skips when broadcaster is undefined', () => {
    const log = createMockLog();
    emitImportStatusSuccess({ broadcaster: undefined, downloadId: 1, bookId: 2, log });
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('catches and logs at debug level when emit throws', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn().mockImplementation(() => { throw new Error('emit fail'); }) };
    emitImportStatusSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, log });
    expect(log.debug).toHaveBeenCalled();
  });

  it('continues emitting remaining events when the first emit throws', () => {
    const log = createMockLog();
    const broadcaster = {
      emit: vi.fn()
        .mockImplementationOnce(() => { throw new Error('first fails'); })
        .mockImplementationOnce(() => {}),
    };
    emitImportStatusSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, log });
    expect(broadcaster.emit).toHaveBeenCalledTimes(2);
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ book_id: 2 }));
  });
});

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
    expect(catchFn).toHaveBeenCalledWith(expect.any(Function));
  });
});

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

  it('records imported event when book had existing path', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const create = vi.fn().mockReturnValue({ catch: catchFn });
    const eventHistory = { create } as never;
    recordImportEvent({
      eventHistory, bookId: 1, bookTitle: 'Book', authorName: 'Author',
      downloadId: 10, bookPath: '/old/path', targetPath: '/lib/book', fileCount: 3, totalSize: 5000, log,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'imported' }));
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

describe('cleanupOldBookPath', () => {
  const ownerDb = (rows: unknown[]) => inject<Db>({ select: () => mockDbChain(rows) });
  const noOwnerDb = () => ownerDb([]);

  // Reset implementations because clearAllMocks leaves persistent fs mocks intact.
  beforeEach(() => {
    vi.mocked(stat).mockReset();
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
    // Keep old-path cleanup on the directory-sweep branch.
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as never);
    vi.mocked(readdir).mockReset();
    vi.mocked(readdir).mockResolvedValue([
      { name: 'a.mp3', isFile: () => true, isDirectory: () => false },
    ] as never);
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined);
    vi.mocked(rmdir).mockReset();
    vi.mocked(rmdir).mockResolvedValue(undefined);
    // Escape coverage overrides this identity realpath.
    vi.mocked(realpath).mockReset();
    vi.mocked(realpath).mockImplementation(async (p: unknown) => String(p));
  });

  it('deletes managed files and logs info on the in-library happy path', async () => {
    const log = createMockLog();
    await cleanupOldBookPath({
      bookPath: '/library/Author/OldTitle',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    });
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('a.mp3'), { force: true });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ oldPath: '/library/Author/OldTitle', newPath: '/library/Author/NewTitle' }),
      expect.stringMatching(/Cleaned old book managed files/i),
    );
  });

  it('skips rm() and logs error-level when bookPath is outside libraryRoot', async () => {
    const log = createMockLog();
    await cleanupOldBookPath({
      bookPath: '/tmp/external',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    });
    expect(rm).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ bookPath: '/tmp/external', libraryRoot: '/library' }),
      expect.stringMatching(/outside library root/i),
    );
  });

  it('does not throw on PathOutsideLibraryError — upgrade flow continues', async () => {
    const log = createMockLog();
    await expect(cleanupOldBookPath({
      bookPath: '/tmp/external',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    })).resolves.toBeUndefined();
  });

  it('refuses + skips rm() when an in-library symlink resolves outside libraryRoot (#1591)', async () => {
    const log = createMockLog();
    vi.mocked(realpath).mockImplementation(async (p: unknown) =>
      (String(p) === '/library/Author/SymlinkBook' ? '/external/real' : String(p)));
    await cleanupOldBookPath({
      bookPath: '/library/Author/SymlinkBook',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    });
    expect(rm).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ bookPath: '/library/Author/SymlinkBook', libraryRoot: '/library' }),
      expect.stringMatching(/outside library root/i),
    );
  });

  it('skips rm() when bookPath is null', async () => {
    const log = createMockLog();
    await cleanupOldBookPath({
      bookPath: null,
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    });
    expect(rm).not.toHaveBeenCalled();
  });

  it('skips rm() when targetPath equals bookPath', async () => {
    const log = createMockLog();
    await cleanupOldBookPath({
      bookPath: '/library/Author/Title',
      targetPath: '/library/Author/Title',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    });
    expect(rm).not.toHaveBeenCalled();
  });

  it('keeps a managed-deletion failure nonfatal — recorded + logged, import continues', async () => {
    const log = createMockLog();
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    await expect(cleanupOldBookPath({
      bookPath: '/library/Author/OldTitle',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('refuses the sweep and logs when a different row owns the old folder', async () => {
    const log = createMockLog();
    await cleanupOldBookPath({
      bookPath: '/library/Author/OldTitle',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: ownerDb([{ id: 42, title: 'Someone Else', path: '/library/Author/OldTitle' }]),
    });
    expect(rm).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ownerBookId: 42 }),
      expect.stringMatching(/another book owns this folder/i),
    );
  });

  it('recognises an owner stored under a different spelling of the same folder', async () => {
    const log = createMockLog();
    await cleanupOldBookPath({
      bookPath: '/library/Author/OldTitle',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      // A row a plain string comparison — or `eq(books.path, …)` — would miss entirely.
      db: ownerDb([{ id: 7, title: 'Legacy Spelling', path: '/library/Author/Other/../OldTitle/' }]),
    });
    expect(rm).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ownerBookId: 7 }),
      expect.stringMatching(/another book owns this folder/i),
    );
  });

  it('never throws into the import when the ownership lookup itself fails, and sweeps nothing', async () => {
    const log = createMockLog();
    await expect(cleanupOldBookPath({
      bookPath: '/library/Author/OldTitle',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: inject<Db>({ select: () => mockDbChain([], { error: new Error('db down') }) }),
    })).resolves.toBeUndefined();
    expect(rm).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookPath: '/library/Author/OldTitle' }),
      expect.stringMatching(/could not establish folder ownership/i),
    );
  });

  it('holds the old path under its claim key for the duration of the sweep', async () => {
    const log = createMockLog();
    const key = claimLockKey('/library/Author/OldTitle');
    let heldDuringSweep = false;
    vi.mocked(rm).mockImplementationOnce(async () => { heldDuringSweep = hasPendingPathWrite(key); });

    await cleanupOldBookPath({
      bookPath: '/library/Author/OldTitle',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
      db: noOwnerDb(),
    });

    expect(heldDuringSweep).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(hasPendingPathWrite(key)).toBe(false);
  });
});

describe('prepareImportSiblings', () => {
  const dirent = (name: string, isFile = true) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });
  const target = '/library/Author/Title';
  const staging = `${target}.import-tmp`;
  const backup = `${target}.import-bak`;
  const marker = `${target}.import-commit-pending`;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  beforeEach(() => {
    // mockReset drains queued stat results that clearAllMocks preserves.
    vi.mocked(stat).mockReset();
    vi.mocked(stat).mockRejectedValue(enoent());
  });

  it('removes any stale staging and backup siblings before staging a fresh import (no marker)', async () => {
    const log = createMockLog();
    await prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log });
    expect(rm).toHaveBeenCalledWith(staging, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
  });

  it('skips removal and logs error-level when a sibling is outside libraryRoot', async () => {
    const log = createMockLog();
    await prepareImportSiblings({ targetPath: '/tmp/x', libraryRoot: '/library', log });
    expect(rm).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ libraryRoot: '/library' }),
      expect.stringMatching(/outside library root/i),
    );
  });

  it('propagates a stale-staging cleanup failure (strict) so the import aborts before staging (F1)', async () => {
    const log = createMockLog();
    // A failed staging clear must abort before stale files can be committed.
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(
      prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log }),
    ).rejects.toThrow('EACCES');
  });

  it('propagates a stale-backup cleanup failure (strict)', async () => {
    const log = createMockLog();
    collapseRemoveTreeBackoff();
    // Persistent, not Once: EBUSY is retryable, and a drained Once queue would let attempt 2 succeed.
    vi.mocked(rm)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await expect(
      prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log }),
    ).rejects.toThrow('EBUSY');
  });

  it('marker present → recovers backed-up audio into target before clearing (#1290)', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('old.m4b')] : []) as never);

    await prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log });

    expect(rename).toHaveBeenCalledWith(join(backup, 'old.m4b'), join(target, 'old.m4b'));
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: target }),
      expect.stringMatching(/Recovering interrupted import commit/i),
    );
  });

  it('marker present but backup empty (in-process rollback already restored) → just removes marker, no restore', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readdir).mockResolvedValue([] as never);

    await prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log });

    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Recovering interrupted import commit/i));
  });

  it('marker present, restore rename fails → throws BackupRecoveryError, leaves backup + marker on disk', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('old.m4b')] : []) as never);
    vi.mocked(rename).mockRejectedValueOnce(new Error('EIO restore'));

    await expect(
      prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log }),
    ).rejects.toBeInstanceOf(BackupRecoveryError);

    expect(rm).not.toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(marker, { force: true });
  });

  it('non-ENOENT marker stat → BackupRecoveryError, never the raw error, so cleanup preserves (#1336 window 2)', async () => {
    const log = createMockLog();
    // Wrap an inconclusive marker stat and fail toward preservation.
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(
      prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log }),
    ).rejects.toBeInstanceOf(BackupRecoveryError);
    expect(rm).not.toHaveBeenCalledWith(backup, { recursive: true, force: true });
  });

  it('marker present, total-clean staging strict-clear fails (EBUSY) → BackupRecoveryError, marker preserved (#1336 window 3 / #1911 F25iii)', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readdir).mockResolvedValue([] as never);
    // Total-clean failures before marker removal must preserve the marker. Persistent, not Once:
    // EBUSY is retryable, and a drained Once queue would let removeTree's second attempt succeed.
    collapseRemoveTreeBackoff();
    vi.mocked(rm).mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await expect(
      prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log }),
    ).rejects.toBeInstanceOf(BackupRecoveryError);
    expect(rm).not.toHaveBeenCalledWith(marker, { force: true });
  });
});

describe('commitStagedImport', () => {
  const dirent = (name: string, isFile = true) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });
  const target = '/library/Author/Title';
  const staging = `${target}.import-tmp`;
  const backup = `${target}.import-bak`;

  /** Return path-specific entries for target and staging. */
  function readdirByPath(map: Record<string, ReturnType<typeof dirent>[]>) {
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (map[p as string] ?? []) as never);
  }

  it('same-path re-import: backs up old audio, moves staged files in, preserves cover, cleans siblings', async () => {
    const log = createMockLog();
    readdirByPath({
      [target]: [dirent('old - 001.mp3'), dirent('old - 002.mp3'), dirent('cover.jpg')],
      [staging]: [dirent('new.m4b')],
    });

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    expect(rename).toHaveBeenCalledWith(join(target, 'old - 001.mp3'), join(backup, 'old - 001.mp3'));
    expect(rename).toHaveBeenCalledWith(join(target, 'old - 002.mp3'), join(backup, 'old - 002.mp3'));
    expect(rename).not.toHaveBeenCalledWith(join(target, 'cover.jpg'), expect.anything());
    expect(rename).toHaveBeenCalledWith(join(staging, 'new.m4b'), join(target, 'new.m4b'));
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(staging, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(target, expect.objectContaining({ recursive: true }));
  });

  it('first import (empty target): no backup created, staged files moved in, staging cleaned', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [], [staging]: [dirent('new.m4b')] });

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    expect(mkdir).not.toHaveBeenCalledWith(backup, expect.anything());
    expect(rename).toHaveBeenCalledWith(join(staging, 'new.m4b'), join(target, 'new.m4b'));
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(staging, { recursive: true, force: true });
  });

  it('same-path re-import: writes the commit-pending marker before backup, removes it on completion (#1290)', async () => {
    const log = createMockLog();
    const marker = `${target}.import-commit-pending`;
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    // Expose sync and close ordering on the directory handle.
    const dirSync = vi.fn().mockResolvedValue(undefined);
    const dirClose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(open).mockResolvedValueOnce({ sync: dirSync, close: dirClose } as unknown as FileHandle);

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    // Flush the marker before any destructive rename.
    expect(writeFile).toHaveBeenCalledWith(marker, '', expect.objectContaining({ flush: true }));
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
    // Normalize actual paths so the marker-before-rename pin works on Windows.
    const norm = (p: unknown): string => String(p).split('\\').join('/');
    const markerWriteOrder = vi.mocked(writeFile).mock.invocationCallOrder[0]!;
    const firstBackupRename = vi.mocked(rename).mock.calls.findIndex(
      (c) => norm(c[0]) === `${target}/old.mp3` && norm(c[1]) === `${backup}/old.mp3`,
    );
    // Guard the index before reading invocationCallOrder.
    expect(firstBackupRename).toBeGreaterThanOrEqual(0);
    const firstBackupRenameOrder = vi.mocked(rename).mock.invocationCallOrder[firstBackupRename]!;
    expect(markerWriteOrder).toBeLessThan(firstBackupRenameOrder);
    // Parent-directory fsync must complete before the first backup rename.
    const dirOpenIdx = vi.mocked(open).mock.calls.findIndex((c) => norm(c[0]) === '/library/Author' && c[1] === 'r');
    expect(dirOpenIdx).toBeGreaterThanOrEqual(0);
    const dirOpenOrder = vi.mocked(open).mock.invocationCallOrder[dirOpenIdx]!;
    expect(dirOpenOrder).toBeLessThan(firstBackupRenameOrder);
    expect(dirSync).toHaveBeenCalled();
    const dirSyncOrder = dirSync.mock.invocationCallOrder[0]!;
    expect(dirSyncOrder).toBeLessThan(firstBackupRenameOrder);
    expect(dirClose).toHaveBeenCalled();
  });

  it('a marker-write failure aborts before any destructive backup rename — nothing destroyed (#1290)', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC marker'));

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('ENOSPC marker');

    expect(rename).not.toHaveBeenCalledWith(join(target, 'old.mp3'), join(backup, 'old.mp3'));
  });

  it('a parent-directory fsync failure does NOT abort the commit — backup renames still run, handle closed (#1339)', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    const close = vi.fn().mockResolvedValue(undefined);
    // Some filesystems reject directory fsync; marker-file flush remains authoritative.
    vi.mocked(open).mockResolvedValueOnce({
      sync: vi.fn().mockRejectedValue(new Error('EINVAL fsync on dir')),
      close,
    } as unknown as FileHandle);

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).resolves.toBeUndefined();

    expect(rename).toHaveBeenCalledWith(join(target, 'old.mp3'), join(backup, 'old.mp3'));
    expect(rename).toHaveBeenCalledWith(join(staging, 'new.m4b'), join(target, 'new.m4b'));
    expect(close).toHaveBeenCalled();
  });

  it('first import (empty target): never writes the commit-pending marker (#1290)', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [], [staging]: [dirent('new.m4b')] });

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it('success-leftover ordering: the strict marker removal runs (inside the try) BEFORE the best-effort backup cleanup; a forced post-success backup-rm failure leaves the marker already gone, so the next import does NOT recover the stale leftover (#1290 gap 1)', async () => {
    const log = createMockLog();
    const marker = `${target}.import-commit-pending`;
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    // Isolate a post-success, best-effort backup cleanup failure.
    collapseRemoveTreeBackoff();
    vi.mocked(rm).mockImplementation(async (p: unknown) => {
      if (p === backup) throw Object.assign(new Error('EBUSY backup leftover'), { code: 'EBUSY' });
      return undefined as never;
    });

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).resolves.toBeUndefined();

    // Remove the marker before disposable backup cleanup; the reverse can resurrect stale audio.
    const markerRmIdx = vi.mocked(rm).mock.calls.findIndex(
      (c) => c[0] === marker && (c[1] as { force?: boolean; recursive?: boolean })?.force === true && !(c[1] as { recursive?: boolean })?.recursive,
    );
    const backupRmIdx = vi.mocked(rm).mock.calls.findIndex(
      (c) => c[0] === backup && (c[1] as { recursive?: boolean })?.recursive === true,
    );
    expect(markerRmIdx).toBeGreaterThanOrEqual(0);
    expect(backupRmIdx).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(rm).mock.invocationCallOrder[markerRmIdx]!)
      .toBeLessThan(vi.mocked(rm).mock.invocationCallOrder[backupRmIdx]!);

    // Restore rm because clearAllMocks leaves its path-specific throw installed.
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined as never);
    vi.mocked(rename).mockClear();

    // A marker-free leftover backup is disposable, never recoverable.
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('old.mp3')] : []) as never);

    await prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log });

    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
  });

  it('a strict marker-removal failure triggers rollback and rethrows (#1290)', async () => {
    const log = createMockLog();
    const marker = `${target}.import-commit-pending`;
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    vi.mocked(rm).mockImplementation(async (p: unknown) => {
      if (p === marker) throw new Error('EBUSY marker');
      return undefined as never;
    });

    try {
      await expect(
        commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
      ).rejects.toThrow('EBUSY marker');

      expect(rename).toHaveBeenCalledWith(join(backup, 'old.mp3'), join(target, 'old.mp3'));
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ targetPath: target }),
        expect.stringMatching(/rolling back/i),
      );
    } finally {
      // clearAllMocks leaves implementations intact.
      vi.mocked(rm).mockReset();
      vi.mocked(rm).mockResolvedValue(undefined);
    }
  });

  it('treats a non-existent target (ENOENT) as no audio to back up', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      if (p === staging) return [dirent('new.m4b')] as never;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    expect(rename).toHaveBeenCalledWith(join(staging, 'new.m4b'), join(target, 'new.m4b'));
    expect(mkdir).not.toHaveBeenCalledWith(backup, expect.anything());
  });

  it('rolls back when a staged-file move fails after old audio was backed up', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    vi.mocked(rename)
      .mockResolvedValueOnce(undefined)                                    // backup old.mp3 -> backup
      .mockRejectedValueOnce(new Error('EIO staged move'))                 // staging/new.m4b -> target FAILS
      .mockResolvedValue(undefined);                                       // rollback restore

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('EIO staged move');

    expect(rename).toHaveBeenCalledWith(join(backup, 'old.mp3'), join(target, 'old.mp3'));
    expect(rm).not.toHaveBeenCalledWith(backup, expect.objectContaining({ recursive: true }));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: target }),
      expect.stringMatching(/rolling back/i),
    );
  });

  it('removes any staged files already moved in during rollback', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('a.m4b'), dirent('b.m4b')] });
    vi.mocked(rename)
      .mockResolvedValueOnce(undefined)               // backup old.mp3
      .mockResolvedValueOnce(undefined)               // staging/a.m4b -> target (moved in)
      .mockRejectedValueOnce(new Error('boom'))       // staging/b.m4b -> target FAILS
      .mockResolvedValue(undefined);                  // rollback restore old.mp3

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('boom');

    expect(rm).toHaveBeenCalledWith(join(target, 'a.m4b'), { force: true });
    expect(rename).toHaveBeenCalledWith(join(backup, 'old.mp3'), join(target, 'old.mp3'));
  });

  it('rolls back when the backup move itself fails partway', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('a.mp3'), dirent('b.mp3')], [staging]: [dirent('new.m4b')] });
    vi.mocked(rename)
      .mockResolvedValueOnce(undefined)                       // a.mp3 -> backup
      .mockRejectedValueOnce(new Error('EXDEV backup move'))  // b.mp3 -> backup FAILS
      .mockResolvedValue(undefined);                          // rollback restore a.mp3

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('EXDEV backup move');

    expect(rename).toHaveBeenCalledWith(join(backup, 'a.mp3'), join(target, 'a.mp3'));
  });

  it('best-effort rollback: a restore failure is logged but never masks the original commit error (F2)', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    vi.mocked(rename)
      .mockResolvedValueOnce(undefined)                       // backup old.mp3
      .mockRejectedValueOnce(new Error('staged move failed')) // staged move FAILS
      .mockRejectedValueOnce(new Error('restore failed'));    // rollback restore ALSO fails

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('staged move failed');

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'restore failed' }) }),
      expect.stringMatching(/Rollback: failed to restore/i),
    );
  });

  it('throws PathOutsideLibraryError before any filesystem mutation when a path escapes the library', async () => {
    const log = createMockLog();
    await expect(
      commitStagedImport({ stagingPath: '/tmp/x.import-tmp', targetPath: '/tmp/x', backupPath: '/tmp/x.import-bak', libraryRoot: '/library', log }),
    ).rejects.toBeInstanceOf(PathOutsideLibraryError);
    expect(rename).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('backs up nested existing target audio recursively, preserving the relative path (#1287 F7)', async () => {
    const log = createMockLog();
    // Admission is recursive, so backup must preserve nested audio paths.
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      if (p === target) return [dirent('Disc 1', false), dirent('cover.jpg')] as never;
      if (p === join(target, 'Disc 1')) return [dirent('old.mp3'), dirent('disc.nfo')] as never;
      if (p === staging) return [dirent('new.m4b')] as never;
      return [] as never;
    });

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    expect(mkdir).toHaveBeenCalledWith(join(backup, 'Disc 1'), { recursive: true });
    expect(rename).toHaveBeenCalledWith(join(target, 'Disc 1', 'old.mp3'), join(backup, 'Disc 1', 'old.mp3'));
    expect(rename).not.toHaveBeenCalledWith(join(target, 'Disc 1', 'disc.nfo'), expect.anything());
    expect(rename).not.toHaveBeenCalledWith(join(target, 'cover.jpg'), expect.anything());
    expect(rename).toHaveBeenCalledWith(join(staging, 'new.m4b'), join(target, 'new.m4b'));
  });

  it('rolls a nested backed-up file back to its original relative path on commit failure (#1287 F7)', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      if (p === target) return [dirent('Disc 1', false)] as never;
      if (p === join(target, 'Disc 1')) return [dirent('old.mp3')] as never;
      if (p === staging) return [dirent('new.m4b')] as never;
      return [] as never;
    });
    vi.mocked(rename)
      .mockResolvedValueOnce(undefined)                     // backup Disc 1/old.mp3 -> backup
      .mockRejectedValueOnce(new Error('EIO staged move'))  // staging/new.m4b -> target FAILS
      .mockResolvedValue(undefined);                        // rollback restore

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('EIO staged move');

    expect(mkdir).toHaveBeenCalledWith(join(target, 'Disc 1'), { recursive: true });
    expect(rename).toHaveBeenCalledWith(join(backup, 'Disc 1', 'old.mp3'), join(target, 'Disc 1', 'old.mp3'));
  });
});

describe('partial in-process rollback restore failure (#1336 window 5)', () => {
  const dirent = (name: string, isFile = true) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });
  const target = '/library/Author/Title';
  // stagedAudioReplace uses the active born-hidden scratch convention.
  const { stagingPath: staging, backupPath: backup, markerPath: marker } = deriveImportSiblings(target);
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  it('best-effort rollback leaves the one unrestored file + marker on disk; the next run converges', async () => {
    const log = createMockLog();

    // A plain move-in error plus one failed restore must preserve marker and backup.
    vi.mocked(readdir).mockImplementation(async (p: unknown) =>
      (p === target ? [dirent('a.mp3'), dirent('z.mp3')] : p === staging ? [dirent('new.m4b')] : []) as never);
    // Preflight and prepare see no marker; failure cleanup sees the newly written marker.
    vi.mocked(stat).mockRejectedValueOnce(enoent()).mockRejectedValueOnce(enoent()).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(rename).mockImplementation(async (src: unknown, dst: unknown) => {
      // Normalize actual and derived paths for Windows.
      const norm = (x: unknown) => String(x).split('\\').join('/');
      const s = norm(src), d = norm(dst);
      if (s === `${norm(staging)}/new.m4b`) throw new Error('EIO move-in');
      if (s === `${norm(backup)}/z.mp3` && d === `${norm(target)}/z.mp3`) throw new Error('EIO restore z');
      return undefined as never;
    });

    const thrown = await stagedAudioReplace({
      targetPath: target, libraryRoot: '/library', log, sourceAudioSize: 1000,
      stage: async () => {},
    }).then(() => null, (e: unknown) => e);

    // Preservation rides on the disk marker, not BackupRecoveryError identity.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(BackupRecoveryError);
    expect((thrown as Error).message).toMatch(/EIO move-in/);
    expect(rename).toHaveBeenCalledWith(join(backup, 'z.mp3'), join(target, 'z.mp3'));
    expect(rm).not.toHaveBeenCalledWith(marker, { force: true });
    expect(rm).toHaveBeenCalledWith(staging, { recursive: true, force: true });

    // The next prepare restores the stranded original and converges.
    vi.mocked(rename).mockReset();
    vi.mocked(rename).mockResolvedValue(undefined as never);
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined as never);
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('z.mp3')] : []) as never);

    await prepareImportSiblings({ targetPath: target, libraryRoot: '/library', log });

    expect(rename).toHaveBeenCalledWith(join(backup, 'z.mp3'), join(target, 'z.mp3'));
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
  });
});

describe('#1911 recovery preservation: strict marker-removal + late total-clean failures abort the caller (F2/F3)', () => {
  const dirent = (name: string, isFile = true) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });
  const target = '/library/Author/Title';
  const { backupPath: backup, legacyBackupPath: legacyBackup, markerPath: marker } =
    deriveImportSiblings(target);

  beforeEach(() => {
    vi.mocked(stat).mockReset();
    // Force the recovery branch with a real marker file.
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(rename).mockResolvedValue(undefined as never);
    vi.mocked(mkdir).mockResolvedValue(undefined as never);
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    // Prevent path-specific rm failures leaking into later suites.
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined as never);
  });

  it('F2 (AC9): a strict marker-removal `rm` failure throws BackupRecoveryError, preserves the marker, and the stage/mutation callback is never reached', async () => {
    const log = createMockLog();
    // Empty backups isolate the final strict marker removal.
    vi.mocked(readdir).mockResolvedValue([] as never);
    vi.mocked(rm).mockImplementation(async (p: unknown, opts: unknown) => {
      const isMarkerRemoval = String(p) === marker && (opts as { force?: boolean; recursive?: boolean })?.force === true
        && !(opts as { recursive?: boolean })?.recursive;
      if (isMarkerRemoval) throw Object.assign(new Error('EACCES marker rm'), { code: 'EACCES' });
      return undefined as never;
    });

    const stage = vi.fn(async () => {});
    const thrown = await stagedAudioReplace({
      targetPath: target, libraryRoot: '/library', log, sourceAudioSize: 1, stage,
    }).then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(BackupRecoveryError);
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
    expect(vi.mocked(rm).mock.calls.filter(([p, o]) =>
      String(p) === marker && (o as { force?: boolean })?.force === true).length).toBe(1);
    expect(stage).not.toHaveBeenCalled();
  });

  it('F3 (AC8/F25iii): a late clear failure on the NON-selected convention throws, retains the marker, and never reaches the stage/mutation callback', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockImplementation(async (p: unknown) =>
      (p === backup ? [dirent('old.m4b')] : []) as never);
    // A late non-selected backup clear must abort before marker removal.
    collapseRemoveTreeBackoff();
    vi.mocked(rm).mockImplementation(async (p: unknown) => {
      if (String(p) === legacyBackup) throw Object.assign(new Error('EBUSY legacy backup'), { code: 'EBUSY' });
      return undefined as never;
    });

    const stage = vi.fn(async () => {});
    const thrown = await stagedAudioReplace({
      targetPath: target, libraryRoot: '/library', log, sourceAudioSize: 1, stage,
    }).then(() => null, (e: unknown) => e);

    expect(rename).toHaveBeenCalledWith(join(backup, 'old.m4b'), join(target, 'old.m4b'));
    expect(thrown).toBeInstanceOf(BackupRecoveryError);
    expect((thrown as BackupRecoveryError).convention).toBe('legacy');
    expect(rm).not.toHaveBeenCalledWith(marker, { force: true });
    expect(stage).not.toHaveBeenCalled();
  });
});

describe('handleImportFailure', () => {
  const mockDb = { update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }) }) };
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  beforeEach(() => {
    // mockReset drains queued stat results that clearAllMocks preserves.
    vi.mocked(stat).mockReset();
    // Marker is absent; every other path is a directory eligible for managed-file sweep.
    vi.mocked(stat).mockImplementation(async (p: unknown) =>
      (String(p).endsWith('.import-commit-pending')
        ? Promise.reject(enoent())
        : ({ isDirectory: () => true, isFile: () => false } as never)));
    // Keep target cleanup on the non-symlink directory branch.
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockImplementation(async (p: unknown) =>
      (String(p).endsWith('.import-commit-pending')
        ? Promise.reject(enoent())
        : ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as never)));
    vi.mocked(readdir).mockReset();
    vi.mocked(readdir).mockResolvedValue([] as never);
    vi.mocked(rmdir).mockReset();
    vi.mocked(rmdir).mockResolvedValue(undefined);
    // Escape coverage overrides this identity realpath.
    vi.mocked(realpath).mockReset();
    vi.mocked(realpath).mockImplementation(async (p: unknown) => String(p));
  });

  it('removes managed files from a disposable targetPath when set (#1589)', async () => {
    const log = createMockLog();
    const error = new Error('import broke');
    vi.mocked(readdir).mockResolvedValue([{ name: 'partial.mp3', isFile: () => true, isDirectory: () => false }] as never);
    // A targetPath in production always has the libraryRoot needed for destructive cleanup.
    await expect(handleImportFailure({
      error, targetPath: '/lib/book', libraryRoot: '/lib', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('import broke');
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('partial.mp3'), { force: true });
    expect(rmdir).toHaveBeenCalledWith('/lib/book');
  });

  it('skips cleanup when targetPath is undefined', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: undefined, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).not.toHaveBeenCalled();
  });

  it('skips the blanket target managed-delete when libraryRoot is absent (#1591)', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockResolvedValue([{ name: 'partial.mp3', isFile: () => true, isDirectory: () => false }] as never);
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/lib/book', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).not.toHaveBeenCalledWith(expect.stringContaining('partial.mp3'), expect.anything());
  });

  it('refuses + skips the managed sweep when an in-library symlink target resolves outside libraryRoot (#1591)', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockResolvedValue([{ name: 'partial.mp3', isFile: () => true, isDirectory: () => false }] as never);
    vi.mocked(realpath).mockImplementation(async (p: unknown) =>
      (String(p) === '/lib/book' ? '/external/real' : String(p)));
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/lib/book', libraryRoot: '/lib', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).not.toHaveBeenCalledWith(expect.stringContaining('partial.mp3'), expect.anything());
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: '/lib/book', libraryRoot: '/lib' }),
      expect.stringMatching(/outside library root/i),
    );
  });

  it('logs warning when a managed targetPath file cannot be deleted', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockResolvedValue([{ name: 'partial.mp3', isFile: () => true, isDirectory: () => false }] as never);
    vi.mocked(rm).mockRejectedValueOnce(new Error('rm fail'));
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/lib/book', libraryRoot: '/lib', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(log.warn).toHaveBeenCalled();
  });

  it('sets download status to failed with error message', async () => {
    const log = createMockLog();
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    const db = { update } as never;

    await expect(handleImportFailure({
      error: new Error('broke'), targetPath: undefined, db,
      downloadId: 42, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('broke');

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      clientStatus: 'failed',
      pipelineStage: 'idle',
      errorMessage: 'broke',
    }));
  });

  it('reverts book status via revertBookStatus', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: undefined, db: mockDb as never,
      downloadId: 1, book: { id: 5, title: 'Book', path: '/old' }, log,
    })).rejects.toThrow('fail');
    expect(revertBookStatus).toHaveBeenCalledWith(mockDb, { id: 5, title: 'Book', path: '/old' }, null);
  });

  it('threads the bookStatusAtGrab snapshot into revertBookStatus (explicit prior-state, not path)', async () => {
    const log = createMockLog();
    // Restore captured pre-grab status rather than infer it from an existing path.
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: undefined, db: mockDb as never,
      downloadId: 1, book: { id: 5, title: 'Book', path: '/old' }, bookStatusAtGrab: 'failed', log,
    })).rejects.toThrow('fail');
    expect(revertBookStatus).toHaveBeenCalledWith(mockDb, { id: 5, title: 'Book', path: '/old' }, 'failed');
  });

  it('rethrows the original error', async () => {
    const log = createMockLog();
    const originalError = new Error('original');
    await expect(handleImportFailure({
      error: originalError, targetPath: undefined, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toBe(originalError);
  });

  it('logs serialized error shape in final log.error call (#621)', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new TypeError('constraint violation'), targetPath: undefined, db: mockDb as never,
      downloadId: 99, book: { id: 3, title: 'Book', path: null }, log,
    })).rejects.toThrow('constraint violation');

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'constraint violation',
          type: 'TypeError',
          stack: expect.any(String),
        }),
        downloadId: 99,
      }),
      'Import failed',
    );
  });

  it('cleans up the staging and backup siblings when provided', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/library/Author/Title',
      stagingPath: '/library/Author/Title.import-tmp', backupPath: '/library/Author/Title.import-bak',
      libraryRoot: '/library', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).toHaveBeenCalledWith('/library/Author/Title.import-tmp', { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith('/library/Author/Title.import-bak', { recursive: true, force: true });
  });

  it('preserves .import-bak and the commit-pending marker while the marker is on disk, clears only staging (#1290/#1336)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    await expect(handleImportFailure({
      error: new BackupRecoveryError(target), targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: true, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toBeInstanceOf(BackupRecoveryError);
    expect(rm).toHaveBeenCalledWith(`${target}.import-tmp`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
  });

  it('preserves the backup for a PLAIN Error when the marker is on disk — identity is no longer load-bearing (#1336)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    // Disk marker presence preserves originals even for an untyped preflight error.
    await expect(handleImportFailure({
      error: new Error('EIO during recovery enumeration'), targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: true, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toThrow('EIO during recovery enumeration');
    expect(rm).toHaveBeenCalledWith(`${target}.import-tmp`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
  });

  it('preserves the backup for a cause-chain-WRAPPED BackupRecoveryError when the marker is on disk (#1336)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    // Wrapping strips BackupRecoveryError identity; the disk gate still holds.
    const wrapped = new Error('wrapped commit failure', { cause: new BackupRecoveryError(target) });
    await expect(handleImportFailure({
      error: wrapped, targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: true, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toBe(wrapped);
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
  });

  it('fails toward preservation when the marker stat errors with a non-ENOENT code (#1336)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    // Inconclusive marker stat fails toward preservation.
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(handleImportFailure({
      error: new Error('ordinary'), targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: true, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toThrow('ordinary');
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: target }),
      expect.stringMatching(/marker stat failed/i),
    );
  });

  it('removes the commit-pending marker on an ordinary (non-recovery) failure (#1290)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    await expect(handleImportFailure({
      error: new Error('ordinary'), targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: true, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toThrow('ordinary');
    expect(rm).toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
  });

  it('does NOT blanket-remove a protected pre-existing target (same-path re-import)', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/library/Author/Title',
      stagingPath: '/library/Author/Title.import-tmp', backupPath: '/library/Author/Title.import-bak',
      libraryRoot: '/library', protectTarget: true, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: '/library/Author/Title' }, log,
    })).rejects.toThrow('fail');
    expect(rm).not.toHaveBeenCalledWith('/library/Author/Title', expect.objectContaining({ recursive: true }));
    expect(rm).toHaveBeenCalledWith('/library/Author/Title.import-tmp', { recursive: true, force: true });
  });

  it('does NOT blanket-remove an UNPROTECTED target while the commit-pending marker is on disk — the half-restored originals survive (#1290 gap 4)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    // Marker preservation must veto blanket target removal even when protectTarget is false.
    await expect(handleImportFailure({
      error: new BackupRecoveryError(target), targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: false, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toBeInstanceOf(BackupRecoveryError);
    expect(rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
    expect(rm).toHaveBeenCalledWith(`${target}.import-tmp`, { recursive: true, force: true });
  });

  it('still removes a disposable (unprotected) scratch target on failure — first import / move-path', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockResolvedValue([{ name: 'partial.mp3', isFile: () => true, isDirectory: () => false }] as never);
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/library/Author/Title',
      stagingPath: '/library/Author/Title.import-tmp', backupPath: '/library/Author/Title.import-bak',
      libraryRoot: '/library', protectTarget: false, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('partial.mp3'), { force: true });
    expect(rmdir).toHaveBeenCalledWith('/library/Author/Title');
  });

  it('preserves a foreign file in a pre-existing/populated targetPath instead of blanket-wiping it (#1589)', async () => {
    const log = createMockLog();
    vi.mocked(readdir).mockResolvedValue([
      { name: 'partial.mp3', isFile: () => true, isDirectory: () => false },
      { name: 'book.epub', isFile: () => true, isDirectory: () => false },
    ] as never);
    vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }));
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/library/Author/Title',
      stagingPath: '/library/Author/Title.import-tmp', backupPath: '/library/Author/Title.import-bak',
      libraryRoot: '/library', protectTarget: false, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('partial.mp3'), { force: true });
    expect(rm).not.toHaveBeenCalledWith(expect.stringContaining('book.epub'), expect.anything());
  });

  it('refuses to remove a target outside libraryRoot but still reverts DB statuses', async () => {
    const log = createMockLog();
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/tmp/external',
      libraryRoot: '/library', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    expect(rm).not.toHaveBeenCalledWith('/tmp/external', expect.objectContaining({ recursive: true }));
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: '/tmp/external', libraryRoot: '/library' }),
      expect.stringMatching(/outside library root/i),
    );
    expect(revertBookStatus).toHaveBeenCalled();
  });
});

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
        .mockImplementationOnce(() => {}),
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

describe('recordImportFailedEvent', () => {
  it('records import_failed event', () => {
    const log = createMockLog();
    const catchFn = vi.fn();
    const create = vi.fn().mockReturnValue({ catch: catchFn });
    recordImportFailedEvent({ eventHistory: { create } as never, bookId: 1, bookTitle: 'Book', authorName: null, downloadId: 10, source: 'auto', error: new Error('fail'), log });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'import_failed' }));
  });

  it('skips when eventHistory is undefined', () => {
    const log = createMockLog();
    recordImportFailedEvent({ eventHistory: undefined, bookId: 1, bookTitle: 'Book', authorName: null, downloadId: 10, source: 'auto', error: new Error('fail'), log });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('checkDiskSpace return type (#229)', () => {
  it('returns { freeGB, requiredGB } on success', async () => {
    vi.mocked(statfs).mockResolvedValue({ bavail: BigInt(100_000_000_000), bsize: BigInt(1) } as never);

    const result = await checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 1_000_000_000 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1,
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
      libraryPath: '/lib', minFreeSpaceGB: 5,
    })).rejects.toThrow('insufficient disk space');
  });

  it('still throws on statfs failure', async () => {
    vi.mocked(statfs).mockRejectedValue(new Error('disk error'));

    await expect(checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 100 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1,
    })).rejects.toThrow('Disk space check failed');
  });
});

describe('isContentFailure classifier (#504, #1346)', () => {
  it('returns true for each typed content-failure message (the five migrated throw sites)', () => {
    expect(isContentFailure(new ContentFailureError('No audio files found in /downloads/book'))).toBe(true);
    expect(isContentFailure(new ContentFailureError('Source file is not a supported audio format: track.xyz'))).toBe(true);
    expect(isContentFailure(new ContentFailureError('Duplicate filename "01.mp3" found during import flattening: "/a" and "/b"'))).toBe(true);
    expect(isContentFailure(new ContentFailureError('Copy verification failed: source 1000 bytes, target 500 bytes'))).toBe(true);
  });

  it('classifies a reworded ContentFailureError by type, not message text (#1304/#1346 mutation check)', () => {
    // Message-free instance proves type, not text, drives classification.
    expect(isContentFailure(new ContentFailureError('audio bytes mismatch after copy'))).toBe(true);
  });

  it('walks error.cause: a wrapped ContentFailureError still classifies (#1346)', () => {
    // Bounded cause traversal reaches a typed inner error.
    const wrapped = new Error('Import step failed', { cause: new ContentFailureError('No audio files found in /x') });
    expect(isContentFailure(wrapped)).toBe(true);
  });

  it('walks a nested cause chain up to the depth cap, then terminates (#1346)', () => {
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: new ContentFailureError('d') }) }) });
    expect(isContentFailure(deep)).toBe(true);

    // A self-referential cycle and an over-depth plain chain return false.
    const cyclic = new Error('loop');
    (cyclic as Error & { cause: unknown }).cause = cyclic;
    expect(isContentFailure(cyclic)).toBe(false);
  });

  it('returns false for an environment error whose message contains a former pattern substring (#1346)', () => {
    // Former message patterns must not revive substring classification.
    expect(isContentFailure(new Error('Path not found: /downloads/No audio files found'))).toBe(false);
    expect(isContentFailure(new Error('Duplicate filename in log line, but a real disk error'))).toBe(false);
    expect(isContentFailure(new Error('Copy verification failed: source 1000 bytes, target 500 bytes'))).toBe(false);
  });

  it('returns false for environment errors (path not found, disk space)', () => {
    expect(isContentFailure(new Error('Path not found: /downloads/book'))).toBe(false);
    expect(isContentFailure(new Error('Import blocked — insufficient disk space'))).toBe(false);
    expect(isContentFailure(new Error('Disk space check failed: permission denied'))).toBe(false);
  });

  it('returns false for audio processing failures', () => {
    expect(isContentFailure(new Error('Audio processing failed: ffmpeg exited with code 1'))).toBe(false);
    expect(isContentFailure(new Error('Audio processing failed: ffmpeg stalled'))).toBe(false);
    expect(isContentFailure(new Error('Audio processing failed: spawn ENOENT'))).toBe(false);
  });

  it('returns false for generic/unknown Error', () => {
    expect(isContentFailure(new Error('something unexpected'))).toBe(false);
  });

  it('returns false for non-Error throwables — including a plain object carrying a former pattern (#1346)', () => {
    expect(isContentFailure('a string error')).toBe(false);
    expect(isContentFailure({ message: 'No audio files found' })).toBe(false);
    expect(isContentFailure({ name: 'ContentFailureError', message: 'Copy verification failed' })).toBe(false);
    expect(isContentFailure(null)).toBe(false);
    expect(isContentFailure(undefined)).toBe(false);
  });
});

describe('verifyCopy', () => {
  it('returns target size when copy matches source audio size', async () => {
    vi.mocked(getPathSize).mockResolvedValue(5000);
    vi.mocked(getAudioPathSize).mockResolvedValue(5000);

    const result = await verifyCopy({ targetPath: '/lib/book', sourcePath: '/src/book' });

    expect(result).toBe(5000);
    expect(getPathSize).toHaveBeenCalledWith('/lib/book');
    expect(getAudioPathSize).toHaveBeenCalledWith('/src/book');
  });

  it('throws when target size is below threshold of source audio size', async () => {
    vi.mocked(getPathSize).mockResolvedValue(400);
    vi.mocked(getAudioPathSize).mockResolvedValue(1000);

    await expect(verifyCopy({ targetPath: '/lib/book', sourcePath: '/src/book' }))
      .rejects.toThrow('Copy verification failed: source 1000 bytes, target 400 bytes');
  });

  it('throws a typed ContentFailureError on a size mismatch (#1304)', async () => {
    vi.mocked(getPathSize).mockResolvedValue(400);
    vi.mocked(getAudioPathSize).mockResolvedValue(1000);

    await expect(verifyCopy({ targetPath: '/lib/book', sourcePath: '/src/book' }))
      .rejects.toBeInstanceOf(ContentFailureError);
  });
});
