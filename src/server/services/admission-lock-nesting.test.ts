import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

/**
 * #2369 AC14, test 4. The admission lock is NOT re-entrant: a section that acquires the same book's
 * lock again awaits a slot only it can settle, and the operation hangs forever. Non-reentrancy is
 * preserved by exposing already-locked inner methods, never by nesting — so every site where a lock
 * holder reaches another enrolled mutator must take exactly ONE acquisition for that book id.
 *
 * Counting acquisitions rather than waiting for a hang: a deadlock shows up as a 15s suite timeout
 * with no indication of which pair broke, and a count names the offender.
 *
 * AC14 names five public/inner pairs. Three are proved here, where the outer caller is cheap to
 * drive: bulk sidecar reconcile → OPF and → remote cover, merge → retag, and the enrichment
 * writeback → embedded cover / remote cover. The remaining two — both import homes reaching the
 * enrichment writeback, and manual import reaching the OPF writer — are proved against the REAL
 * import operations in `import-admission-boundary.integration.test.ts`, which counts acquisitions
 * across a whole end-to-end import rather than around a stubbed call.
 */
const acquisitions: number[] = [];

vi.mock('../utils/book-admission-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/book-admission-lock.js')>();
  return {
    ...actual,
    withBookAdmissionLock: vi.fn(<T>(bookId: number, fn: () => Promise<T>) => {
      acquisitions.push(bookId);
      return actual.withBookAdmissionLock(bookId, fn);
    }),
  };
});

vi.mock('./cover-download.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cover-download.js')>();
  return { ...actual, downloadRemoteCoverWithinAdmissionLock: vi.fn().mockResolvedValue('written') };
});

vi.mock('../utils/opf-writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/opf-writer.js')>();
  return { ...actual, writeOpfSidecarWithinAdmissionLock: vi.fn().mockResolvedValue('written') };
});

vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('@core/utils/mutagen-resolver.js', () => ({ resolveMutagenPython: vi.fn().mockResolvedValue('python3') }));
vi.mock('./mutagen-tag-writer.js', () => ({ writeTagsWithMutagen: vi.fn().mockResolvedValue({ ok: true, warnings: [] }) }));

// One taggable file so the retag reaches the writer instead of short-circuiting on an empty folder.
const AUDIO_ENTRY = { name: 'Merged.m4b', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false, size: 10 }),
  readdir: vi.fn().mockImplementation(async (_dir: string, options?: { withFileTypes?: boolean }) =>
    (options?.withFileTypes ? [AUDIO_ENTRY] : [AUDIO_ENTRY.name])),
}));

import { reconcileBookSidecars } from './bulk-sidecar-reconcile.js';
import { downloadRemoteCoverWithinAdmissionLock } from './cover-download.js';
import { writeOpfSidecarWithinAdmissionLock } from '../utils/opf-writer.js';
import { withBookAdmissionLock } from './book-admission.js';
import { retagMergedOutput } from './merge-post-tag.js';
import { TaggingService } from './tagging.service.js';
import { enrichBookFromAudioWithinAdmissionLock } from './enrichment-utils.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { writeTagsWithMutagen } from './mutagen-tag-writer.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';

/** One row read + one update; enough for the writeback and the retag projection. */
function stubDb(row: Record<string, unknown> = {}): Db {
  return inject<Db>({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  });
}

describe('nested acquisition is never taken twice for one book (AC14)', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    acquisitions.length = 0;
    vi.mocked(downloadRemoteCoverWithinAdmissionLock).mockResolvedValue('written');
    vi.mocked(writeOpfSidecarWithinAdmissionLock).mockResolvedValue('written');
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  /**
   * Bulk sidecar reconcile reaches BOTH the OPF writer and the remote cover download. AC12 requires
   * one acquisition covering both — they target the same folder, and a rename landing between them
   * would leave the two sidecars in different folders.
   */
  it('takes exactly one acquisition for a bulk sidecar reconcile that writes OPF and a cover', async () => {
    const outcome = await reconcileBookSidecars({
      bookId: 42,
      title: 'Piranesi',
      bookFolder: '/library/Clarke/Piranesi',
      coverUrl: 'https://cdn.example.com/cover.jpg',
      bookService: inject<BookService>({}),
      db: stubDb({ path: '/library/Clarke/Piranesi', coverUrl: 'https://cdn.example.com/cover.jpg' }),
      log,
    });

    expect(outcome).toEqual({ failed: false });
    expect(acquisitions.filter((id) => id === 42)).toHaveLength(1);
    // Both writes ran, and each through the INNER form — the public wrappers would have
    // re-acquired the id already held and deadlocked.
    expect(writeOpfSidecarWithinAdmissionLock).toHaveBeenCalledTimes(1);
    expect(downloadRemoteCoverWithinAdmissionLock).toHaveBeenCalledTimes(1);
  });

  it('still takes exactly one acquisition when only the OPF half runs', async () => {
    await reconcileBookSidecars({
      bookId: 7,
      title: 'No Cover',
      bookFolder: '/library/Author/No Cover',
      coverUrl: null,
      bookService: inject<BookService>({}),
      db: stubDb({ path: '/library/Author/No Cover', coverUrl: null }),
      log,
    });

    expect(acquisitions.filter((id) => id === 7)).toHaveLength(1);
    expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
  });

  /** Case 27: the pointer early-return happens ahead of any acquisition. */
  it('takes no acquisition at all for a pointer book', async () => {
    const outcome = await reconcileBookSidecars({
      bookId: 9,
      title: 'Pointer',
      bookFolder: '/library/Loose/Pointer.m4b',
      coverUrl: 'https://cdn.example.com/cover.jpg',
      bookService: inject<BookService>({}),
      db: stubDb({ path: '/library/Loose/Pointer.m4b', coverUrl: null }),
      log,
    });

    expect(outcome).toEqual({ failed: false });
    expect(acquisitions).toEqual([]);
    expect(writeOpfSidecarWithinAdmissionLock).not.toHaveBeenCalled();
    expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
  });

  /**
   * Merge holds the book's section from its own row read through post-tag, so the retag it reaches
   * must be the inner form. The service is real: a regression to `retagBook` records a second
   * acquisition here rather than hanging the suite.
   */
  it('takes no further acquisition when merge post-tag retags inside the section it holds', async () => {
    const bookId = 11;
    vi.mocked(writeTagsWithMutagen).mockResolvedValue({ ok: true } as never);
    const settingsService = inject<SettingsService>({
      get: vi.fn().mockImplementation(async (category: string) =>
        category === 'tagging' ? { enabled: true, mode: 'fill-empty', embedCover: false, writeOpf: false } : {}),
    });
    const bookService = inject<BookService>({
      getById: vi.fn().mockResolvedValue({
        id: bookId, title: 'Merged', path: '/library/Author/Merged', authors: [], narrators: [],
        seriesName: null, seriesPosition: null, asin: null, subtitle: null, description: null,
        publisher: null, publishedDate: null, genres: null, coverUrl: null,
      }),
    });
    const taggingService = new TaggingService(stubDb(), settingsService, log, bookService);

    const warnings = await withBookAdmissionLock(bookId, () =>
      retagMergedOutput({ db: stubDb(), settingsService, log, taggingService }, bookId, '/library/Author/Merged/Merged.m4b'));

    expect(warnings).toEqual([]);
    // The retag really reached the tag writer, so the count below is about a completed nested call.
    expect(writeTagsWithMutagen).toHaveBeenCalledTimes(1);
    expect(acquisitions.filter((id) => id === bookId)).toHaveLength(1);
  });

  /**
   * The audio-enrichment writeback runs inside its caller's section (import, merge). Its own cover
   * work — embedded extraction and the remote download AC12 stopped firing and forgetting — must
   * therefore reach the inner cover writer.
   */
  it('takes no further acquisition when the enrichment writeback downloads a remote cover', async () => {
    const bookId = 21;
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
      fileFormat: 'M4B', fileCount: 1, totalSize: 1000, totalDuration: 600, hasCoverArt: false,
    } as never);

    const result = await withBookAdmissionLock(bookId, () =>
      enrichBookFromAudioWithinAdmissionLock(
        bookId,
        '/library/Author/Enriched',
        { coverUrl: 'https://cdn.example.com/cover.jpg' } as never,
        stubDb(),
        log,
      ));

    expect(result).toEqual({ enriched: true });
    expect(downloadRemoteCoverWithinAdmissionLock).toHaveBeenCalledTimes(1);
    expect(acquisitions.filter((id) => id === bookId)).toHaveLength(1);
  });
});
