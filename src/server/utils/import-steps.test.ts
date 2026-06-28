import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

// Mock dependencies before imports
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  // #1598: deleteManagedBookFiles classifies the top-level bookPath via `lstat` (not `stat`) so a
  // symlinked source is never followed. The cleanupOldBookPath / handleImportFailure suites configure
  // it per-describe to report a non-symlink directory (the symlink branch is covered in delete-managed-files.test.ts).
  lstat: vi.fn(),
  readdir: vi.fn(),
  // #1674: deleteManagedBookFiles (reached via cleanupOldBookPath/handleImportFailure) now reads a
  // root `metadata.opf` for the narratorr provenance marker. Default to UNMARKED (foreign) content so
  // a swept OPF is preserved unless a test stages a marked body — matching import.service.test.ts.
  readFile: vi.fn().mockResolvedValue('<?xml version="1.0"?><package><metadata><dc:title>foreign</dc:title></metadata></package>'),
  rm: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  // #1591: cleanupOldBookPath / handleImportFailure now run the symlink-aware realpath containment.
  // Identity realpath (no symlinks) → lexical-equivalent containment for the in-library test paths.
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

  it('throws a typed ContentFailureError with byte-identical message when directory has no audio files (#1346)', async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => false, isDirectory: () => true } as unknown as Stats);
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue([
      { name: 'readme.txt', isFile: () => true, isDirectory: () => false },
    ] as never);

    // Type drives classification; message text is byte-for-byte unchanged so log greps still match.
    await expect(validateSource('/downloads/book', undefined, null)).rejects.toBeInstanceOf(ContentFailureError);
    await expect(validateSource('/downloads/book', undefined, null)).rejects.toThrow('No audio files found in /downloads/book');
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

// ── copyToLibrary ─────────────────────────────────────────────────────────

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

// ── checkDiskSpace ──────────────────────────────────────────────────────

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

    // Should not throw with plenty of space
    await checkDiskSpace({
      sourcePath: '/src', sourceStats: { isDirectory: () => false, size: 1_000_000_000 } as unknown as Stats,
      libraryPath: '/lib', minFreeSpaceGB: 1,
    });
    expect(statfs).toHaveBeenCalledWith('/lib');
  });

  it('throws when insufficient space with exact GB in message', async () => {
    // Only 1 GB free but need more
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

// ── emitImportStatusSuccess ─────────────────────────────────────────────

describe('emitImportStatusSuccess', () => {
  it('emits download_status_change and book_status_change events', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitImportStatusSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, log });
    expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({ download_id: 1, new_status: 'imported' }));
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ book_id: 2, new_status: 'imported' }));
  });

  // #1108 — job-lifecycle completion is owned by ImportQueueWorker, not this helper.
  it('does NOT emit import_complete (job-lifecycle event owned by the queue worker)', () => {
    const log = createMockLog();
    const broadcaster = { emit: vi.fn() };
    emitImportStatusSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, log });
    const completeCalls = broadcaster.emit.mock.calls.filter(([eventName]) => eventName === 'import_complete');
    expect(completeCalls).toHaveLength(0);
  });

  it('skips when broadcaster is undefined', () => {
    const log = createMockLog();
    // Should not throw
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
        .mockImplementationOnce(() => {}), // book_status_change succeeds
    };
    emitImportStatusSuccess({ broadcaster: broadcaster as never, downloadId: 1, bookId: 2, log });
    expect(broadcaster.emit).toHaveBeenCalledTimes(2);
    expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', expect.objectContaining({ book_id: 2 }));
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

// ── cleanupOldBookPath ──────────────────────────────────────────────────

describe('cleanupOldBookPath', () => {
  // #1589: cleanupOldBookPath now deletes only MANAGED files (audio + cover) via the shared helper,
  // preserving foreign files in the old folder. The helper sweep reads dirents from the old dir.
  // Reset+default fs mocks here (clearAllMocks does NOT reset implementations) so a persistent
  // mock can't leak into the next describe; tests use `*Once` for rejections.
  beforeEach(() => {
    vi.mocked(stat).mockReset();
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true, isFile: () => false } as never);
    // #1598: the helper classifies the top-level bookPath via `lstat` — a non-symlink directory keeps
    // the old-path cleanup on the directory-sweep path.
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
    // #1591: restore identity realpath each test (no symlinks); the escape test overrides it.
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
    })).resolves.toBeUndefined();
  });

  it('refuses + skips rm() when an in-library symlink resolves outside libraryRoot (#1591)', async () => {
    const log = createMockLog();
    // Lexically inside, but realpath escapes the root → realpath-aware guard must reject.
    vi.mocked(realpath).mockImplementation(async (p: unknown) =>
      (String(p) === '/library/Author/SymlinkBook' ? '/external/real' : String(p)));
    await cleanupOldBookPath({
      bookPath: '/library/Author/SymlinkBook',
      targetPath: '/library/Author/NewTitle',
      libraryRoot: '/library',
      log,
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
    })).resolves.toBeUndefined();
    // The helper records the failed managed deletion and logs a warning; cleanup stays nonfatal.
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

// ── prepareImportSiblings ───────────────────────────────────────────────

describe('prepareImportSiblings', () => {
  const dirent = (name: string, isFile = true) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });
  const target = '/library/Author/Title';
  const staging = `${target}.import-tmp`;
  const backup = `${target}.import-bak`;
  const marker = `${target}.import-commit-pending`;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  beforeEach(() => {
    // `mockReset()` BEFORE establishing the default drains any `*Once()` stat queue a prior
    // test left behind — the global `beforeEach(clearAllMocks)` does NOT drain those queues
    // (CLAUDE.md `vi.clearAllMocks()` gotcha), and these marker-state tests sequence stat
    // results, so a leaked queued response would otherwise contaminate this default (#1340 gap 6).
    vi.mocked(stat).mockReset();
    // Default: no commit-pending marker on disk → no recovery, fast strict-clear path.
    vi.mocked(stat).mockRejectedValue(enoent());
  });

  it('removes any stale staging and backup siblings before staging a fresh import (no marker)', async () => {
    const log = createMockLog();
    await prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });
    expect(rm).toHaveBeenCalledWith(staging, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
  });

  it('skips removal and logs error-level when a sibling is outside libraryRoot', async () => {
    const log = createMockLog();
    await prepareImportSiblings({ stagingPath: '/tmp/x.import-tmp', targetPath: '/tmp/x', backupPath: '/tmp/x.import-bak', libraryRoot: '/library', log });
    expect(rm).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ libraryRoot: '/library' }),
      expect.stringMatching(/outside library root/i),
    );
  });

  it('propagates a stale-staging cleanup failure (strict) so the import aborts before staging (F1)', async () => {
    const log = createMockLog();
    // A leftover .import-tmp whose rm fails must NOT be silently reused — otherwise
    // commitStagedImport would enumerate and commit the stale files into the target.
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(
      prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('EACCES');
  });

  it('propagates a stale-backup cleanup failure (strict)', async () => {
    const log = createMockLog();
    // staging rm succeeds, backup rm fails → still aborts rather than proceeding over leftover state.
    vi.mocked(rm)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await expect(
      prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('EBUSY');
  });

  it('marker present → recovers backed-up audio into target before clearing (#1290)', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);             // marker exists (#1341: a real marker reads as a file)
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('old.m4b')] : []) as never);

    await prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    // Backed-up original restored into the target...
    expect(rename).toHaveBeenCalledWith(join(backup, 'old.m4b'), join(target, 'old.m4b'));
    // ...the now-empty backup strict-cleared, and the marker removed.
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: target }),
      expect.stringMatching(/Recovering interrupted import commit/i),
    );
  });

  it('marker present but backup empty (in-process rollback already restored) → just removes marker, no restore', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);             // marker exists (#1341: a real marker reads as a file)
    vi.mocked(readdir).mockResolvedValue([] as never);                 // empty backup

    await prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    expect(rename).not.toHaveBeenCalled();                            // nothing to restore
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Recovering interrupted import commit/i));
  });

  it('marker present, restore rename fails → throws BackupRecoveryError, leaves backup + marker on disk', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);             // marker exists (#1341: a real marker reads as a file)
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('old.m4b')] : []) as never);
    vi.mocked(rename).mockRejectedValueOnce(new Error('EIO restore'));

    await expect(
      prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toBeInstanceOf(BackupRecoveryError);

    // Backup and marker are NOT removed — they survive for the next boot's recovery.
    expect(rm).not.toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(marker, { force: true });
  });

  it('non-ENOENT marker stat → BackupRecoveryError, never the raw error, so cleanup preserves (#1336 window 2)', async () => {
    const log = createMockLog();
    // A non-ENOENT marker stat must not propagate raw (it would reach cleanup as a plain
    // Error and delete the backup). It surfaces as a BackupRecoveryError → preserve.
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(
      prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toBeInstanceOf(BackupRecoveryError);
    // Neither sibling is strict-cleared — the marker sighting was inconclusive, fail toward preservation.
    expect(rm).not.toHaveBeenCalledWith(backup, { recursive: true, force: true });
  });

  it('marker present, staging strict-clear fails (EBUSY) → BackupRecoveryError, backup preserved (#1336 window 3)', async () => {
    const log = createMockLog();
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);             // marker exists (#1341: a real marker reads as a file)
    // A killed commit leaves a populated .import-tmp; an EBUSY clearing it on the recovery
    // boot must surface as BackupRecoveryError (→ preserve), not propagate raw.
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await expect(
      prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toBeInstanceOf(BackupRecoveryError);
    expect(rm).not.toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(marker, { force: true });
  });
});

// ── commitStagedImport ──────────────────────────────────────────────────

describe('commitStagedImport', () => {
  const dirent = (name: string, isFile = true) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });
  const target = '/library/Author/Title';
  const staging = `${target}.import-tmp`;
  const backup = `${target}.import-bak`;

  /** Route readdir results by path so target vs staging return distinct sets. */
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

    // Existing audio moved to backup (per-file rename, not deleted)...
    expect(rename).toHaveBeenCalledWith(join(target, 'old - 001.mp3'), join(backup, 'old - 001.mp3'));
    expect(rename).toHaveBeenCalledWith(join(target, 'old - 002.mp3'), join(backup, 'old - 002.mp3'));
    // ...cover left untouched (non-audio stays in targetPath)...
    expect(rename).not.toHaveBeenCalledWith(join(target, 'cover.jpg'), expect.anything());
    // ...new staged file moved into the target...
    expect(rename).toHaveBeenCalledWith(join(staging, 'new.m4b'), join(target, 'new.m4b'));
    // ...and both siblings removed on success.
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(staging, { recursive: true, force: true });
    // The target folder itself is never wholesale-deleted.
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
    // Track the directory handle so we can assert it is sync'd then closed on the
    // success path (the swallowed-failure path is covered by a sibling test).
    const dirSync = vi.fn().mockResolvedValue(undefined);
    const dirClose = vi.fn().mockResolvedValue(undefined);
    vi.mocked(open).mockResolvedValueOnce({ sync: dirSync, close: dirClose } as unknown as FileHandle);

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    // Marker written (empty) once a backup is about to be created — and DURABLY
    // flushed (`{ flush: true }`) so a power loss can't persist the renames while
    // dropping the un-fsync'd marker (#1339). A regression that drops the flush
    // fails this assertion.
    expect(writeFile).toHaveBeenCalledWith(marker, '', expect.objectContaining({ flush: true }));
    // ...and strict-removed on a successful commit.
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
    // The marker MUST be written BEFORE the first destructive backup rename — a
    // crash in that window must find the marker so recovery fires (#1290). Assert
    // the ordering directly: the (sole) marker write precedes the first rename
    // (`${target}/old.mp3` → `${backup}/old.mp3`), so reordering the write after
    // the backup loop would fail this test.
    // Windows path-separator normalization (CLAUDE.md "Windows path separators in tests"):
    // production builds the rename/open args with `join()`, which emits backslashes on
    // Windows but forward slashes on Linux/CI. Normalize the ACTUAL mock-call args before
    // matching the forward-slash needles so this ordering pin holds on a Windows dev machine,
    // not just on Linux CI — without it the `findIndex` returns -1 on Windows and the ordering
    // assertion runs against index -1 (a silent local-only failure, #1340 gap 5).
    const norm = (p: unknown): string => String(p).split('\\').join('/');
    const markerWriteOrder = vi.mocked(writeFile).mock.invocationCallOrder[0]!;
    const firstBackupRename = vi.mocked(rename).mock.calls.findIndex(
      (c) => norm(c[0]) === `${target}/old.mp3` && norm(c[1]) === `${backup}/old.mp3`,
    );
    // Fail LOUDLY when the needle is genuinely absent (e.g. a real reordering regression):
    // guard the index before using it as an invocationCallOrder subscript.
    expect(firstBackupRename).toBeGreaterThanOrEqual(0);
    const firstBackupRenameOrder = vi.mocked(rename).mock.invocationCallOrder[firstBackupRename]!;
    expect(markerWriteOrder).toBeLessThan(firstBackupRenameOrder);
    // The best-effort parent-directory fsync (entry durability) opens the marker's
    // parent dir BEFORE the first backup rename (#1339).
    const dirOpenIdx = vi.mocked(open).mock.calls.findIndex((c) => norm(c[0]) === '/library/Author' && c[1] === 'r');
    expect(dirOpenIdx).toBeGreaterThanOrEqual(0);
    const dirOpenOrder = vi.mocked(open).mock.invocationCallOrder[dirOpenIdx]!;
    expect(dirOpenOrder).toBeLessThan(firstBackupRenameOrder);
    // ...and — the assertion that actually pins durability — the handle `sync()`
    // (the fsync that flushes the directory entry) COMPLETES before the first
    // backup rename. Pinning `open()` alone is insufficient: a regression that
    // opens the dir early, renames, and only then awaits `sync()` would still
    // satisfy the open-order check while violating the ordering this PR protects.
    expect(dirSync).toHaveBeenCalled();
    const dirSyncOrder = dirSync.mock.invocationCallOrder[0]!;
    expect(dirSyncOrder).toBeLessThan(firstBackupRenameOrder);
    // The handle is always closed (no descriptor leak).
    expect(dirClose).toHaveBeenCalled();
  });

  it('a marker-write failure aborts before any destructive backup rename — nothing destroyed (#1290)', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    // Writing the marker first means a marker-write failure aborts before the
    // backup loop, so no original is ever renamed out of the target.
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC marker'));

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).rejects.toThrow('ENOSPC marker');

    // The original was NOT moved into .import-bak — the existing book is untouched.
    expect(rename).not.toHaveBeenCalledWith(join(target, 'old.mp3'), join(backup, 'old.mp3'));
  });

  it('a parent-directory fsync failure does NOT abort the commit — backup renames still run, handle closed (#1339)', async () => {
    const log = createMockLog();
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    const close = vi.fn().mockResolvedValue(undefined);
    // The marker file flush succeeds; only the best-effort directory fsync rejects
    // (some filesystems reject fsync on a directory handle). The file flush already
    // provides the durability that matters, so the commit must proceed regardless.
    vi.mocked(open).mockResolvedValueOnce({
      sync: vi.fn().mockRejectedValue(new Error('EINVAL fsync on dir')),
      close,
    } as unknown as FileHandle);

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).resolves.toBeUndefined();

    // The commit proceeded: the original was backed up and the staged file moved in.
    expect(rename).toHaveBeenCalledWith(join(target, 'old.mp3'), join(backup, 'old.mp3'));
    expect(rename).toHaveBeenCalledWith(join(staging, 'new.m4b'), join(target, 'new.m4b'));
    // The directory handle is closed even on the swallowed-fsync path (no leak).
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
    // Force the POST-success best-effort backup cleanup (`removeImportSibling(backupPath)`,
    // outside the try) to reject; the strict marker removal (last step inside the try) and
    // the staging cleanup still succeed. A best-effort failure is swallowed, so the commit
    // resolves with the disposable backup left on disk.
    vi.mocked(rm).mockImplementation(async (p: unknown) => {
      if (p === backup) throw Object.assign(new Error('EBUSY backup leftover'), { code: 'EBUSY' });
      return undefined as never;
    });

    await expect(
      commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
    ).resolves.toBeUndefined();

    // ORDERING PIN: the strict marker removal (`rm(marker, { force })`, inside the try) must
    // precede the best-effort backup cleanup (`rm(backup, { recursive, force })`, post-success).
    // Reordering them would leave marker + backup TOGETHER after a SUCCESS — the next import
    // would "recover" the stale backup over the committed audio. Assert the invocation order
    // directly so that swap fails this test.
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

    // Restore the default rm + isolate rename history for the realistic next-import phase.
    // (`clearAllMocks()` does NOT reset implementations — drop the path-specific throw so it
    // never leaks into later tests; #1340 gap 6 / CLAUDE.md `clearAllMocks` gotcha.)
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined as never);
    vi.mocked(rename).mockClear();

    // The marker is already gone (strict rm ran first), so the next import over the leftover
    // backup sees marker-ABSENT → strict-clears the disposable backup, NEVER recovers it. This
    // is the REALISTIC no-marker leftover state (produced by the forced backup-rm failure
    // above), distinct from the false-positive guard that fabricates it.
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('old.mp3')] : []) as never);

    await prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    // No recovery restore from the stale leftover — the marker-absent path strict-clears it.
    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
  });

  it('a strict marker-removal failure triggers rollback and rethrows (#1290)', async () => {
    const log = createMockLog();
    const marker = `${target}.import-commit-pending`;
    readdirByPath({ [target]: [dirent('old.mp3')], [staging]: [dirent('new.m4b')] });
    // backup + move-in succeed; the authoritative marker removal fails.
    vi.mocked(rm).mockImplementation(async (p: unknown) => {
      if (p === marker) throw new Error('EBUSY marker');
      return undefined as never;
    });

    try {
      await expect(
        commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log }),
      ).rejects.toThrow('EBUSY marker');

      // The existing rollback ran (restores the backed-up original).
      expect(rename).toHaveBeenCalledWith(join(backup, 'old.mp3'), join(target, 'old.mp3'));
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ targetPath: target }),
        expect.stringMatching(/rolling back/i),
      );
    } finally {
      // clearAllMocks() does NOT reset implementations — restore rm's default so the
      // path-specific throw never leaks into later tests.
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

    // Backed-up audio restored into the target — existing book left intact.
    expect(rename).toHaveBeenCalledWith(join(backup, 'old.mp3'), join(target, 'old.mp3'));
    // Commit threw before the success cleanup — siblings not removed here.
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

    // The already-moved staged file is removed from the target on rollback.
    expect(rm).toHaveBeenCalledWith(join(target, 'a.m4b'), { force: true });
    // And the backed-up original is restored.
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

    // Only the audio that made it to backup is restored.
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
    // Target audio lives under a subdirectory; the gate (recursive getAudioPathSize)
    // admits it, so the backup must descend into `Disc 1` or the old audio survives.
    vi.mocked(readdir).mockImplementation(async (p: unknown) => {
      if (p === target) return [dirent('Disc 1', false), dirent('cover.jpg')] as never;
      if (p === join(target, 'Disc 1')) return [dirent('old.mp3'), dirent('disc.nfo')] as never;
      if (p === staging) return [dirent('new.m4b')] as never;
      return [] as never;
    });

    await commitStagedImport({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    // Nested audio backed up under its relative path inside the backup dir...
    expect(mkdir).toHaveBeenCalledWith(join(backup, 'Disc 1'), { recursive: true });
    expect(rename).toHaveBeenCalledWith(join(target, 'Disc 1', 'old.mp3'), join(backup, 'Disc 1', 'old.mp3'));
    // ...nested non-audio (disc.nfo) and top-level cover left untouched...
    expect(rename).not.toHaveBeenCalledWith(join(target, 'Disc 1', 'disc.nfo'), expect.anything());
    expect(rename).not.toHaveBeenCalledWith(join(target, 'cover.jpg'), expect.anything());
    // ...and the new staged file moved into the target top level.
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

    // Rollback recreates the subdir, then restores the nested backup to its origin.
    expect(mkdir).toHaveBeenCalledWith(join(target, 'Disc 1'), { recursive: true });
    expect(rename).toHaveBeenCalledWith(join(backup, 'Disc 1', 'old.mp3'), join(target, 'Disc 1', 'old.mp3'));
  });
});

// ── in-process rollback restore failure → marker-gated preservation → convergence ──

describe('partial in-process rollback restore failure (#1336 window 5)', () => {
  const dirent = (name: string, isFile = true) => ({ name, isFile: () => isFile, isDirectory: () => !isFile });
  const target = '/library/Author/Title';
  const staging = `${target}.import-tmp`;
  const backup = `${target}.import-bak`;
  const marker = `${target}.import-commit-pending`;
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  it('best-effort rollback leaves the one unrestored file + marker on disk; the next run converges', async () => {
    const log = createMockLog();

    // ── Act 1: drive the real caller chain (stagedAudioReplace → commitStagedImport) into a
    // commit where the staged move-in fails AND exactly one rollback restore rename fails.
    // The catch must preserve `.import-bak` + the marker based on the marker's DISK presence,
    // even though the rethrown error is the PLAIN move-in error (not a BackupRecoveryError).
    vi.mocked(readdir).mockImplementation(async (p: unknown) =>
      (p === target ? [dirent('a.mp3'), dirent('z.mp3')] : p === staging ? [dirent('new.m4b')] : []) as never);
    // Stat order: the #1341 stagedAudioReplace preflight stats the marker (absent → no
    // conflict), then prepareImportSiblings stats it (absent → no recovery); the catch's
    // markerPresent then sees it present (commitStagedImport wrote it before backing up) —
    // a real marker is a file, so it reads as present (#1341 isFile).
    vi.mocked(stat).mockRejectedValueOnce(enoent()).mockRejectedValueOnce(enoent()).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(rename).mockImplementation(async (src: unknown, dst: unknown) => {
      // Normalize separators: production builds these args with join() (backslashes on Windows),
      // so match against the POSIX needles below regardless of host.
      const s = String(src).split('\\').join('/'), d = String(dst).split('\\').join('/');
      if (s === `${staging}/new.m4b`) throw new Error('EIO move-in');           // move-in fails → rollback
      if (s === `${backup}/z.mp3` && d === `${target}/z.mp3`) throw new Error('EIO restore z'); // one restore fails (swallowed)
      return undefined as never;                                                // backups + a.mp3 restore succeed
    });

    const thrown = await stagedAudioReplace({
      targetPath: target, libraryRoot: '/library', log, sourceAudioSize: 1000,
      stage: async () => { /* getAudioPathSize is mocked to 1000 → verify passes */ },
    }).then(() => null, (e: unknown) => e);

    // The controlling error is the plain move-in failure, NOT a BackupRecoveryError —
    // preservation rides on the disk marker, not the error's identity (#1336).
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(BackupRecoveryError);
    expect((thrown as Error).message).toMatch(/EIO move-in/);
    // The unrestored original's restore WAS attempted (and failed best-effort) → z.mp3 is left in .import-bak.
    expect(rename).toHaveBeenCalledWith(join(backup, 'z.mp3'), join(target, 'z.mp3'));
    // The catch preserved the marker: removeMarker (the only `rm(marker, { force })` caller on
    // the failure path) was never invoked. A regression that drops the marker gate from the
    // stagedAudioReplace catch would call it here.
    expect(rm).not.toHaveBeenCalledWith(marker, { force: true });
    // Staging is still cleared (re-derivable scratch).
    expect(rm).toHaveBeenCalledWith(staging, { recursive: true, force: true });

    // ── Act 2: the next boot re-enters prepareImportSiblings. The marker is present and the
    // backup still holds the unrestored z.mp3 → recovery restores it and clears both siblings.
    vi.mocked(rename).mockReset();
    vi.mocked(rename).mockResolvedValue(undefined as never);
    vi.mocked(rm).mockReset();
    vi.mocked(rm).mockResolvedValue(undefined as never);
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);                       // marker present (#1341: a real marker reads as a file)
    vi.mocked(readdir).mockImplementation(async (p: unknown) => (p === backup ? [dirent('z.mp3')] : []) as never);

    await prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot: '/library', log });

    // The leftover original is restored, then the now-empty backup and the marker are cleared.
    expect(rename).toHaveBeenCalledWith(join(backup, 'z.mp3'), join(target, 'z.mp3'));
    expect(rm).toHaveBeenCalledWith(backup, { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(marker, { force: true });
  });
});

// ── handleImportFailure ─────────────────────────────────────────────────

describe('handleImportFailure', () => {
  const mockDb = { update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }) }) };
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  beforeEach(() => {
    // `mockReset()` first drains any `*Once()` stat queue a prior test left behind — the global
    // `beforeEach(clearAllMocks)` does NOT drain those queues (CLAUDE.md gotcha), so without
    // this a leaked queued response would shadow the marker-aware default below (#1340 gap 6).
    vi.mocked(stat).mockReset();
    // Marker-aware default (#1336/#1589): the commit-pending marker reads ABSENT (ENOENT) so
    // ordinary cleanup runs; any OTHER path (the target) reads as a directory so the managed-file
    // sweep can enumerate it. A blanket reject would make the helper treat the target as missing.
    vi.mocked(stat).mockImplementation(async (p: unknown) =>
      (String(p).endsWith('.import-commit-pending')
        ? Promise.reject(enoent())
        : ({ isDirectory: () => true, isFile: () => false } as never)));
    // #1598: the helper classifies the top-level targetPath via `lstat` — mirror the marker-aware
    // stat default and report a non-symlink directory so the managed-file sweep enumerates the target.
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockImplementation(async (p: unknown) =>
      (String(p).endsWith('.import-commit-pending')
        ? Promise.reject(enoent())
        : ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as never)));
    // Default to an EMPTY target dir; tests asserting managed-file removal set their own readdir.
    vi.mocked(readdir).mockReset();
    vi.mocked(readdir).mockResolvedValue([] as never);
    vi.mocked(rmdir).mockReset();
    vi.mocked(rmdir).mockResolvedValue(undefined);
    // #1591: identity realpath each test (no symlinks); the escape test overrides it.
    vi.mocked(realpath).mockReset();
    vi.mocked(realpath).mockImplementation(async (p: unknown) => String(p));
  });

  it('removes managed files from a disposable targetPath when set (#1589)', async () => {
    const log = createMockLog();
    const error = new Error('import broke');
    vi.mocked(readdir).mockResolvedValue([{ name: 'partial.mp3', isFile: () => true, isDirectory: () => false }] as never);
    // #1591: the blanket target managed-delete is now library-root-gated, so supply libraryRoot
    // (matching the production invariant that a defined targetPath always has a defined libraryRoot).
    await expect(handleImportFailure({
      error, targetPath: '/lib/book', libraryRoot: '/lib', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('import broke');
    // Managed audio removed per-file; the emptied scratch folder is then cleaned up.
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
    // targetPath set, no libraryRoot, protectTarget/preserveBackup false → destructive cleanup is
    // library-root-gated, so the managed sweep must NOT run (no rm of target contents).
    vi.mocked(readdir).mockResolvedValue([{ name: 'partial.mp3', isFile: () => true, isDirectory: () => false }] as never);
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/lib/book', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    // The marker cleanup still runs, but the managed-file sweep of target contents must NOT.
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
    // #1591: library-root-gated managed-delete → supply libraryRoot to exercise the path.
    await expect(handleImportFailure({
      error: new Error('fail'), targetPath: '/lib/book', libraryRoot: '/lib', db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: null }, log,
    })).rejects.toThrow('fail');
    // The managed-file helper records the failure and logs a warning; the import error still rethrows.
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

    // Import failure → canonical failure tuple (failed, idle) in one guarded update.
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
    // Book has a path on disk (old path-inference would force 'imported'), but the
    // captured pre-grab lifecycle was 'failed' — the revert must restore 'failed'.
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
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never); // marker present on disk (#1341: a real marker reads as a file)
    await expect(handleImportFailure({
      error: new BackupRecoveryError(target), targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: true, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toBeInstanceOf(BackupRecoveryError);
    // Staging cleared (re-derivable scratch)...
    expect(rm).toHaveBeenCalledWith(`${target}.import-tmp`, { recursive: true, force: true });
    // ...but the backup and marker survive for the next boot's recovery.
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
  });

  it('preserves the backup for a PLAIN Error when the marker is on disk — identity is no longer load-bearing (#1336)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never); // marker present on disk (#1341: a real marker reads as a file)
    // A raw readdir/stat error or pre-flight throw reaches cleanup as a plain Error — the
    // prior `instanceof BackupRecoveryError` gate would have deleted the stranded originals.
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
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never); // marker present on disk (#1341: a real marker reads as a file)
    // `new Error(msg, { cause })` strips the BackupRecoveryError identity — the disk gate holds.
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
    // A non-ENOENT marker stat error must NOT be read as "marker absent" → delete; treat as present.
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
    // Siblings cleaned, but the existing book folder is never recursively removed.
    expect(rm).not.toHaveBeenCalledWith('/library/Author/Title', expect.objectContaining({ recursive: true }));
    expect(rm).toHaveBeenCalledWith('/library/Author/Title.import-tmp', { recursive: true, force: true });
  });

  it('does NOT blanket-remove an UNPROTECTED target while the commit-pending marker is on disk — the half-restored originals survive (#1290 gap 4)', async () => {
    const log = createMockLog();
    const target = '/library/Author/Title';
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never); // marker present on disk (#1341: a real marker reads as a file)
    // protectTarget:false would normally blanket-rm the target (first-import / move-path), but
    // the marker's presence (preserveBackup) must VETO that — the half-restored originals live
    // IN the target during a preserved recovery. This pins the `!preserveBackup` clause on the
    // target blanket-rm in handleImportFailure: removing it (so the rm gates only on
    // `!protectTarget`) would delete the genuine-loss collision case the marker protects, and
    // the existing protectTarget:true tests would NOT catch that (they skip the rm via
    // `!protectTarget` regardless of the marker).
    await expect(handleImportFailure({
      error: new BackupRecoveryError(target), targetPath: target,
      stagingPath: `${target}.import-tmp`, backupPath: `${target}.import-bak`,
      libraryRoot: '/library', protectTarget: false, db: mockDb as never,
      downloadId: 1, book: { id: 1, title: 'Book', path: target }, log,
    })).rejects.toBeInstanceOf(BackupRecoveryError);
    // The target is NOT blanket-removed despite protectTarget:false...
    expect(rm).not.toHaveBeenCalledWith(target, { recursive: true, force: true });
    // ...and the backup + marker survive for the next boot's recovery...
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-bak`, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(`${target}.import-commit-pending`, { force: true });
    // ...while staging is still cleared (re-derivable scratch).
    expect(rm).toHaveBeenCalledWith(`${target}.import-tmp`, { recursive: true, force: true });
  });

  it('still removes a disposable (unprotected) scratch target on failure — first import / move-path', async () => {
    const log = createMockLog();
    // Genuine scratch target holding only import-written audio → fully removed (folder gone).
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
    // Pre-commit failure into a target that pre-exists with a bundled e-book alongside partial audio:
    // managed audio is removed, the foreign .epub is preserved, and the folder is retained.
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
    // Managed audio removed; the foreign e-book was never touched.
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
    recordImportFailedEvent({ eventHistory: { create } as never, bookId: 1, bookTitle: 'Book', authorName: null, downloadId: 10, source: 'auto', error: new Error('fail'), log });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'import_failed' }));
  });

  it('skips when eventHistory is undefined', () => {
    const log = createMockLog();
    recordImportFailedEvent({ eventHistory: undefined, bookId: 1, bookTitle: 'Book', authorName: null, downloadId: 10, source: 'auto', error: new Error('fail'), log });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ── #229 Observability — checkDiskSpace return type ─────────────────────
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
    // Classification rides the type, not the substring (#1346) — every content-failure site
    // constructs a ContentFailureError, so these pass via the instanceof path.
    expect(isContentFailure(new ContentFailureError('No audio files found in /downloads/book'))).toBe(true);
    expect(isContentFailure(new ContentFailureError('Source file is not a supported audio format: track.xyz'))).toBe(true);
    expect(isContentFailure(new ContentFailureError('Duplicate filename "01.mp3" found during import flattening: "/a" and "/b"'))).toBe(true);
    expect(isContentFailure(new ContentFailureError('Copy verification failed: source 1000 bytes, target 500 bytes'))).toBe(true);
  });

  it('classifies a reworded ContentFailureError by type, not message text (#1304/#1346 mutation check)', () => {
    // No recognizable substring — proves the instanceof path, not the string, drives
    // classification. Rewording any throw site can no longer silently break it.
    expect(isContentFailure(new ContentFailureError('audio bytes mismatch after copy'))).toBe(true);
  });

  it('walks error.cause: a wrapped ContentFailureError still classifies (#1346)', () => {
    // Mirrors the in-file wrap-with-cause pattern (import-steps.ts) — instanceof on the
    // outer error is false, but the bounded cause walk reaches the typed inner cause.
    const wrapped = new Error('Import step failed', { cause: new ContentFailureError('No audio files found in /x') });
    expect(isContentFailure(wrapped)).toBe(true);
  });

  it('walks a nested cause chain up to the depth cap, then terminates (#1346)', () => {
    // A ContentFailureError buried a few levels deep still classifies...
    const deep = new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: new ContentFailureError('d') }) }) });
    expect(isContentFailure(deep)).toBe(true);

    // ...but a self-referential chain cannot spin (cycle detection) and a plain chain
    // deeper than the cap with no typed link returns false rather than looping forever.
    const cyclic = new Error('loop');
    (cyclic as Error & { cause: unknown }).cause = cyclic;
    expect(isContentFailure(cyclic)).toBe(false);
  });

  it('returns false for an environment error whose message contains a former pattern substring (#1346)', () => {
    // The substring fallback is gone: a plain Error carrying a former pattern no longer
    // mis-classifies as content — this is the steering vector #1346 closes.
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
    // Corrected docblock claim: a JSON-revived plain object that lost its prototype is NOT
    // an Error, so it never classifies regardless of message text.
    expect(isContentFailure('a string error')).toBe(false);
    expect(isContentFailure({ message: 'No audio files found' })).toBe(false);
    expect(isContentFailure({ name: 'ContentFailureError', message: 'Copy verification failed' })).toBe(false);
    expect(isContentFailure(null)).toBe(false);
    expect(isContentFailure(undefined)).toBe(false);
  });
});

// ── verifyCopy ──────────────────────────────────────────────────────────

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
    // COPY_VERIFICATION_THRESHOLD = 0.99, so target must be >= source * 0.99
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
