import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { inject, createMockSettingsService } from '../__tests__/helpers.js';
import { rescanLibraryWithCompanionSweep } from './library-rescan-sweep.js';
import { LibraryScanService, ScanInProgressError, LibraryPathError, type RescanResult } from './library-scan.service.js';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

/** `select().from().where()` resolving to zero books — the scan body runs, the row loop does not. */
function createEmptyDb(): Db {
  return inject<Db>({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  });
}

/** The wrapper is a SWEEP-only seam, so its stub carries `reconcileAll` and nothing else. */
function createCompanionStub() {
  return { reconcileAll: vi.fn().mockResolvedValue(undefined) };
}

/**
 * The same stub plus a `reconcileBook` PROBE — an extra property the wrapper's
 * `CompanionSweepTrigger` parameter does not declare, so it can only be reached by code that
 * went looking for it. Used by the one test that asserts the wrapper never fans out per-book;
 * everywhere else it would be exactly the irrelevant fixture member the narrow interface exists
 * to eliminate.
 */
function createProbedCompanionStub() {
  return {
    reconcileAll: vi.fn().mockResolvedValue(undefined),
    reconcileBook: vi.fn().mockResolvedValue(undefined),
  };
}

const SUMMARY: RescanResult = { scanned: 3, missing: 1, restored: 0 };

describe('rescanLibraryWithCompanionSweep (#1960 AC9–AC14)', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.resetAllMocks();
    log = createMockLogger();
  });

  // ==========================================================================
  // AC12 — which outcomes sweep, and that the error identity survives
  // ==========================================================================

  describe('AC12 outcome matrix', () => {
    it('a successful rescan sweeps once, never per-book, and returns the summary unchanged', async () => {
      const companionEbook = createProbedCompanionStub();
      const libraryScan = { rescanLibrary: vi.fn().mockResolvedValue(SUMMARY) };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .resolves.toEqual(SUMMARY);

      expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(companionEbook.reconcileBook).not.toHaveBeenCalled();
    });

    it('ScanInProgressError triggers NO sweep — nothing was scanned and the in-flight scan owns its own', async () => {
      const companionEbook = createCompanionStub();
      const error = new ScanInProgressError();
      const libraryScan = { rescanLibrary: vi.fn().mockRejectedValue(error) };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .rejects.toBe(error);

      expect(companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    it('LibraryPathError sweeps and rethrows the SAME error instance', async () => {
      const companionEbook = createCompanionStub();
      const error = new LibraryPathError('Library path is not configured');
      const libraryScan = { rescanLibrary: vi.fn().mockRejectedValue(error) };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .rejects.toBe(error);

      expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('an unexpected throw sweeps and rethrows the SAME error instance', async () => {
      const companionEbook = createCompanionStub();
      const error = new Error('Unexpected DB failure');
      const libraryScan = { rescanLibrary: vi.fn().mockRejectedValue(error) };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .rejects.toBe(error);

      expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('a non-Error rejection is rethrown verbatim so the route still stringifies it', async () => {
      const companionEbook = createCompanionStub();
      const libraryScan = { rescanLibrary: vi.fn().mockRejectedValue('unknown') };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .rejects.toBe('unknown');

      expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // AC10/AC13/AC14 — ordering, against the REAL scan lock
  // ==========================================================================

  describe('ordering against a real LibraryScanService', () => {
    let root: string;
    let libraryScan: LibraryScanService;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'narratorr-rescan-sweep-'));
      libraryScan = new LibraryScanService(
        createEmptyDb(),
        inject<BookService>({}),
        inject<BookImportService>({}),
        inject<MetadataService>({}),
        inject<SettingsService>(createMockSettingsService({ library: { path: root } })),
        log,
        inject<EventHistoryService>({}),
      );
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('AC10/AC13: the sweep is not invoked until that rescan released `scanning`', async () => {
      // The probe IS the assertion: `rescanLibrary` throws `ScanInProgressError` synchronously
      // while the flag is held, so a probe that succeeds proves the service's own `finally`
      // already ran. No timers, no sleeps — the ordering is read off the real lock.
      let scanLockFree: boolean | null = null;
      let resolveSweep!: () => void;
      const sweepStarted = new Promise<void>((r) => { resolveSweep = r; });

      const companionEbook = {
        reconcileAll: vi.fn().mockImplementation(async () => {
          try {
            await libraryScan.rescanLibrary();
            scanLockFree = true;
          } catch (error: unknown) {
            scanLockFree = !(error instanceof ScanInProgressError);
          }
          resolveSweep();
        }),
      };

      await rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log });
      await sweepStarted;

      expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(scanLockFree).toBe(true);
    });

    it('AC13/AC14: a second rescan may begin while an earlier sweep is still reading — that overlap is LEGAL, not a bug to fix', async () => {
      // Sweep A never settles, so it is provably still in flight for the whole test.
      let releaseSweepA!: () => void;
      const sweepA = new Promise<void>((r) => { releaseSweepA = r; });
      const companionEbook = { reconcileAll: vi.fn().mockReturnValue(sweepA) };

      await rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log });
      expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(1);

      // The second rescan runs to completion — no ScanInProgressError, because the sweep does
      // not hold `scanning`. This test exists so a future reader does not "fix" AC13 back into
      // a global mutual-exclusion invariant.
      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .resolves.toEqual({ scanned: 0, missing: 0, restored: 0 });
      expect(companionEbook.reconcileAll).toHaveBeenCalledTimes(2);

      releaseSweepA();
      await sweepA;
    });

    it('AC11: the wrapper adds no companion work inside the scan — reconcileAll is never called before rescanLibrary settles', async () => {
      const order: string[] = [];
      const spy = vi.spyOn(libraryScan, 'rescanLibrary').mockImplementation(async () => {
        order.push('scan-start');
        await Promise.resolve();
        order.push('scan-end');
        return { scanned: 0, missing: 0, restored: 0 };
      });
      const companionEbook = {
        reconcileAll: vi.fn().mockImplementation(() => { order.push('sweep'); return Promise.resolve(); }),
      };

      await rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log });

      expect(order).toEqual(['scan-start', 'scan-end', 'sweep']);
      spy.mockRestore();
    });
  });

  // ==========================================================================
  // Isolation — the sweep can never change what the caller sees
  // ==========================================================================

  describe('sweep isolation', () => {
    it('a REJECTING reconcileAll does not fail the rescan', async () => {
      const companionEbook = { reconcileAll: vi.fn().mockRejectedValue(new Error('sweep rejected')) };
      const libraryScan = { rescanLibrary: vi.fn().mockResolvedValue(SUMMARY) };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .resolves.toEqual(SUMMARY);
    });

    it('a SYNCHRONOUSLY THROWING reconcileAll does not fail the rescan', async () => {
      const companionEbook = {
        reconcileAll: vi.fn().mockImplementation(() => { throw new Error('sweep threw synchronously'); }),
      };
      const libraryScan = { rescanLibrary: vi.fn().mockResolvedValue(SUMMARY) };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .resolves.toEqual(SUMMARY);
    });

    it('a synchronously throwing reconcileAll on the ERROR path still rethrows the original scan error', async () => {
      const companionEbook = {
        reconcileAll: vi.fn().mockImplementation(() => { throw new Error('sweep threw synchronously'); }),
      };
      const error = new LibraryPathError('Library path is not configured');
      const libraryScan = { rescanLibrary: vi.fn().mockRejectedValue(error) };

      await expect(rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log }))
        .rejects.toBe(error);
    });

    it('no reconciler wired at all is a clean no-op', async () => {
      const libraryScan = { rescanLibrary: vi.fn().mockResolvedValue(SUMMARY) };
      await expect(rescanLibraryWithCompanionSweep({ libraryScan, log }))
        .resolves.toEqual(SUMMARY);
    });
  });
});
