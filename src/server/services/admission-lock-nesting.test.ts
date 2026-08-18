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

import { reconcileBookSidecars } from './bulk-sidecar-reconcile.js';
import { downloadRemoteCoverWithinAdmissionLock } from './cover-download.js';
import { writeOpfSidecarWithinAdmissionLock } from '../utils/opf-writer.js';
import type { BookService } from './book.service.js';

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
      db: inject<Db>({}),
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
      db: inject<Db>({}),
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
      db: inject<Db>({}),
      log,
    });

    expect(outcome).toEqual({ failed: false });
    expect(acquisitions).toEqual([]);
    expect(writeOpfSidecarWithinAdmissionLock).not.toHaveBeenCalled();
    expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
  });
});
