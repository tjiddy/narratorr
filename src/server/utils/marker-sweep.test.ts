import { describe, it, expect, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  sweepCommitPendingMarkers,
  findCommitPendingMarkers,
  convergeStrandedMarker,
} from './import-steps.js';

/**
 * #1338 — boot-time sweep that converges stranded `.import-commit-pending` markers the
 * same-target retry trigger (#1290) never revisits: failed downloads, manual jobs, and
 * recomputed-target orphans. These tests arrange the interrupted on-disk state under a real
 * tmpdir library root and drive the real sweep, asserting disk state after convergence.
 *
 * Real tmpdir (not mocked fs) is used deliberately per hazard #1391: a blanket
 * `stat.mockResolvedValue(...)` would make every marker read as PRESENT and flip the
 * deletion assertions.
 */

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

interface Siblings {
  target: string;
  staging: string;
  backup: string;
  marker: string;
}

function siblings(target: string): Siblings {
  return {
    target,
    staging: `${target}.import-tmp`,
    backup: `${target}.import-bak`,
    marker: `${target}.import-commit-pending`,
  };
}

describe('sweepCommitPendingMarkers (#1338 startup marker sweep)', () => {
  function withTmp(fn: (root: string) => Promise<void>): () => Promise<void> {
    return async () => {
      const root = mkdtempSync(join(tmpdir(), 'narratorr-1338-'));
      try {
        await fn(root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };
  }

  it('case 1: failed-download stranded marker — restores originals, clears marker + backup + .import-tmp scratch, one info log names the target', withTmp(async (root) => {
    const { target, staging, backup, marker } = siblings(join(root, 'Author', 'Title'));
    const originalBytes = Buffer.alloc(400, 9);
    // Half-replaced target present (a staged file already moved in), originals in backup,
    // a stale .import-tmp scratch dir, and the marker proving the interruption.
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'new.m4b'), Buffer.from('STAGED-NEW'));
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), originalBytes);
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'leftover.partial'), Buffer.from('scratch'));
    await writeFile(marker, '');

    const log = makeLog();
    const result = await sweepCommitPendingMarkers(root, log);

    expect(result).toEqual({ converged: 1, skipped: [] });
    // Original restored into the target.
    expect(await readFile(join(target, 'old.m4b'))).toEqual(originalBytes);
    // Marker, backup, AND stale staging scratch all cleared.
    expect(await pathExists(marker)).toBe(false);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(staging)).toBe(false);
    // Exactly one info log names the recovered target.
    const targetInfoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([arg]) => arg && typeof arg === 'object' && (arg as { targetPath?: string }).targetPath === target,
    );
    expect(targetInfoCalls).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  }));

  it('case 2: deleted target folder — recreates the folder and restores, no BackupRecoveryError', withTmp(async (root) => {
    const { target, backup, marker } = siblings(join(root, 'Author', 'Gone'));
    const bytes = Buffer.alloc(300, 5);
    // Target folder was rm'd while stranded; only the backup + marker remain.
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), bytes);
    await writeFile(marker, '');
    expect(await pathExists(target)).toBe(false);

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
    expect(await pathExists(marker)).toBe(false);
    expect(await pathExists(backup)).toBe(false);
  }));

  it('case 3: backup-MISSING half-state — clears the marker without throwing', withTmp(async (root) => {
    const { target, backup, marker } = siblings(join(root, 'Author', 'NoBackup'));
    await mkdir(target, { recursive: true });
    await writeFile(marker, '');
    // .import-bak deliberately absent.
    expect(await pathExists(backup)).toBe(false);

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await pathExists(marker)).toBe(false);
  }));

  it('case 4: non-convergent path surfaced — preserves state, warns naming the path, continues to a healthy marker', withTmp(async (root) => {
    const bad = siblings(join(root, 'Author', 'Wedged'));
    const good = siblings(join(root, 'Author', 'Healthy'));
    // Bad: `.import-bak` is a FILE → readdir ENOTDIR → BackupRecoveryError, state preserved.
    await mkdir(dirname(bad.target), { recursive: true });
    await writeFile(bad.backup, Buffer.from('not-a-directory'));
    await writeFile(bad.marker, '');
    // Good: a normal stranded marker that DOES converge.
    const goodBytes = Buffer.alloc(200, 7);
    await mkdir(good.backup, { recursive: true });
    await writeFile(join(good.backup, 'old.m4b'), goodBytes);
    await writeFile(good.marker, '');

    const log = makeLog();
    const result = await sweepCommitPendingMarkers(root, log);

    expect(result.converged).toBe(1);
    expect(result.skipped).toEqual([bad.marker]);
    // Bad path preserved — nothing deleted.
    expect(await pathExists(bad.marker)).toBe(true);
    expect(await pathExists(bad.backup)).toBe(true);
    // Healthy path converged despite the earlier failure.
    expect(await readFile(join(good.target, 'old.m4b'))).toEqual(goodBytes);
    expect(await pathExists(good.marker)).toBe(false);
    // Warn enumerates the skipped path.
    const warned = (log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      ([arg]) => arg && typeof arg === 'object' && (arg as { markerPath?: string }).markerPath === bad.marker,
    );
    expect(warned).toBe(true);
  }));

  it('case 5: no markers — cheap no-op, no info/warn logs', withTmp(async (root) => {
    await mkdir(join(root, 'Author', 'Title'), { recursive: true });
    await writeFile(join(root, 'Author', 'Title', 'book.m4b'), Buffer.alloc(10, 1));

    const log = makeLog();
    const result = await sweepCommitPendingMarkers(root, log);

    expect(result).toEqual({ converged: 0, skipped: [] });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    // At most the single optional "no stranded markers" debug line.
    expect((log.debug as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
  }));

  it('case 6: nested-depth discovery — recursive walk finds + converges a two-levels-deep marker', withTmp(async (root) => {
    const { target, backup, marker } = siblings(join(root, 'A', 'B', 'Title'));
    const bytes = Buffer.alloc(150, 4);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), bytes);
    await writeFile(marker, '');

    // The recursive finder must descend to depth 2.
    expect(await findCommitPendingMarkers(root)).toEqual([marker]);

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
    expect(await pathExists(marker)).toBe(false);
  }));

  it('case 7: assertPathInsideLibrary gate — a marker whose target escapes the root is skipped, no destructive op', withTmp(async (root) => {
    const lib = join(root, 'lib');
    await mkdir(lib, { recursive: true });
    // A marker physically OUTSIDE the library root. Its backup is seeded so we can assert it
    // is never touched. (The normal walk can't surface this, so drive the per-marker primitive.)
    const { target, backup, marker } = siblings(join(root, 'outside', 'Foreign'));
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), Buffer.from('UNTOUCHED'));
    await writeFile(marker, '');

    const log = makeLog();
    const converged = await convergeStrandedMarker(marker, lib, log);

    expect(converged).toBe(false);
    // Nothing acted on: backup + marker intact, target never created.
    expect(await pathExists(marker)).toBe(true);
    expect(await readFile(join(backup, 'old.m4b'), 'utf8')).toBe('UNTOUCHED');
    expect(await pathExists(target)).toBe(false);
    const warned = (log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      ([arg]) => arg && typeof arg === 'object' && (arg as { markerPath?: string }).markerPath === marker,
    );
    expect(warned).toBe(true);
  }));

  it('case 8: idempotency — a second sweep over a converged path is a clean no-op', withTmp(async (root) => {
    const { target, backup, marker } = siblings(join(root, 'Author', 'Title'));
    const bytes = Buffer.alloc(400, 9);
    await mkdir(target, { recursive: true });
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), bytes);
    await writeFile(marker, '');

    const first = await sweepCommitPendingMarkers(root, makeLog());
    expect(first).toEqual({ converged: 1, skipped: [] });

    // Second pass: marker + backup already gone, so the walk finds nothing.
    const log2 = makeLog();
    const second = await sweepCommitPendingMarkers(root, log2);
    expect(second).toEqual({ converged: 0, skipped: [] });
    expect(log2.warn).not.toHaveBeenCalled();
    // Restored file still intact.
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
  }));

  it('findCommitPendingMarkers: ENOENT root yields no markers, and scratch siblings are not descended', withTmp(async (root) => {
    // ENOENT-tolerant: a non-existent root is "no markers", not a throw.
    expect(await findCommitPendingMarkers(join(root, 'does-not-exist'))).toEqual([]);

    // A `.import-commit-pending` file buried inside a `.import-bak` scratch dir is NOT collected.
    const bak = join(root, 'Author', 'Title.import-bak');
    await mkdir(bak, { recursive: true });
    await writeFile(join(bak, 'decoy.import-commit-pending'), '');
    // A real sibling marker beside the book folder IS collected.
    const realMarker = join(root, 'Author', 'Title.import-commit-pending');
    await writeFile(realMarker, '');

    expect(await findCommitPendingMarkers(root)).toEqual([realMarker]);
  }));
});
