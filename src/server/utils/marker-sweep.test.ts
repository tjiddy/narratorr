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
  prepareImportSiblings,
  BackupRecoveryError,
  BackupAmbiguityError,
} from './import-steps.js';
import { deriveImportSiblings } from './import-sibling-paths.js';

// Use a real tmpdir: mocked stat can make every marker appear present.

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
  activeStaging: string;
  activeBackup: string;
  marker: string;
}

function siblings(target: string): Siblings {
  const d = deriveImportSiblings(target);
  return {
    target,
    staging: d.legacyStagingPath,
    backup: d.legacyBackupPath,
    activeStaging: d.stagingPath,
    activeBackup: d.backupPath,
    marker: d.markerPath,
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
    // Model a half-replaced target with stranded originals and stale staging.
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
    expect(await readFile(join(target, 'old.m4b'))).toEqual(originalBytes);
    expect(await pathExists(marker)).toBe(false);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(staging)).toBe(false);
    const targetInfoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([arg]) => arg && typeof arg === 'object' && (arg as { targetPath?: string }).targetPath === target,
    );
    expect(targetInfoCalls).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  }));

  it('case 2: deleted target folder — recreates the folder and restores, no BackupRecoveryError', withTmp(async (root) => {
    const { target, backup, marker } = siblings(join(root, 'Author', 'Gone'));
    const bytes = Buffer.alloc(300, 5);
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
    expect(await pathExists(backup)).toBe(false);

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await pathExists(marker)).toBe(false);
  }));

  it('case 4: non-convergent path surfaced — preserves state, warns naming the path, continues to a healthy marker', withTmp(async (root) => {
    const bad = siblings(join(root, 'Author', 'Wedged'));
    const good = siblings(join(root, 'Author', 'Healthy'));
    // A file at the backup path forces an ENOTDIR preservation error.
    await mkdir(dirname(bad.target), { recursive: true });
    await writeFile(bad.backup, Buffer.from('not-a-directory'));
    await writeFile(bad.marker, '');
    const goodBytes = Buffer.alloc(200, 7);
    await mkdir(good.backup, { recursive: true });
    await writeFile(join(good.backup, 'old.m4b'), goodBytes);
    await writeFile(good.marker, '');

    const log = makeLog();
    const result = await sweepCommitPendingMarkers(root, log);

    expect(result.converged).toBe(1);
    expect(result.skipped).toEqual([bad.marker]);
    expect(await pathExists(bad.marker)).toBe(true);
    expect(await pathExists(bad.backup)).toBe(true);
    expect(await readFile(join(good.target, 'old.m4b'))).toEqual(goodBytes);
    expect(await pathExists(good.marker)).toBe(false);
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
    expect((log.debug as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
  }));

  it('case 6: nested-depth discovery — recursive walk finds + converges a two-levels-deep marker', withTmp(async (root) => {
    const { target, backup, marker } = siblings(join(root, 'A', 'B', 'Title'));
    const bytes = Buffer.alloc(150, 4);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), bytes);
    await writeFile(marker, '');

    expect(await findCommitPendingMarkers(root)).toEqual([marker]);

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
    expect(await pathExists(marker)).toBe(false);
  }));

  it('case 7: assertPathInsideLibrary gate — a marker whose target escapes the root is skipped, no destructive op', withTmp(async (root) => {
    const lib = join(root, 'lib');
    await mkdir(lib, { recursive: true });
    // The normal walk cannot surface an outside-root marker, so use the per-marker seam.
    const { target, backup, marker } = siblings(join(root, 'outside', 'Foreign'));
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), Buffer.from('UNTOUCHED'));
    await writeFile(marker, '');

    const log = makeLog();
    const converged = await convergeStrandedMarker(marker, lib, log);

    expect(converged).toBe(false);
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

    const log2 = makeLog();
    const second = await sweepCommitPendingMarkers(root, log2);
    expect(second).toEqual({ converged: 0, skipped: [] });
    expect(log2.warn).not.toHaveBeenCalled();
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
  }));

  it('findCommitPendingMarkers: ENOENT root yields no markers, and a TRUE scratch sibling (beside its live marker) is not descended', withTmp(async (root) => {
    expect(await findCommitPendingMarkers(join(root, 'does-not-exist'))).toEqual([]);

    // A matching sibling marker identifies this suffix-shaped directory as real scratch.
    const bak = join(root, 'Author', 'Title.import-bak');
    await mkdir(bak, { recursive: true });
    await writeFile(join(bak, 'decoy.import-commit-pending'), '');
    const realMarker = join(root, 'Author', 'Title.import-commit-pending');
    await writeFile(realMarker, '');

    expect(await findCommitPendingMarkers(root)).toEqual([realMarker]);
  }));

  it('F1: walks a legitimate library directory whose name ends in a scratch suffix but has NO sibling marker', withTmp(async (root) => {
    // A suffix-shaped folder without a sibling marker is legitimate library content.
    const buriedMarker = join(root, 'Series.import-bak', 'Title.import-commit-pending');
    await mkdir(dirname(buriedMarker), { recursive: true });
    await writeFile(buriedMarker, '');
    const buriedMarker2 = join(root, 'Collection.import-tmp', 'Inner', 'Book.import-commit-pending');
    await mkdir(dirname(buriedMarker2), { recursive: true });
    await writeFile(buriedMarker2, '');

    const found = await findCommitPendingMarkers(root);
    expect(found.sort()).toEqual([buriedMarker2, buriedMarker].sort());
  }));

  it('F1: the sweep converges a marker buried under a legitimate suffix-named library folder', withTmp(async (root) => {
    const target = join(root, 'Series.import-bak', 'Title');
    const backup = `${target}.import-bak`;
    const marker = `${target}.import-commit-pending`;
    const bytes = Buffer.alloc(120, 3);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), bytes);
    await writeFile(marker, '');

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
    expect(await pathExists(marker)).toBe(false);
  }));

  it('F3: BackupRecoveryError message carries operator remedy guidance (.import-bak + retry/boot-sweep)', withTmp(async (root) => {
    // Force a real ENOTDIR recovery failure for the user-facing message.
    const { target, backup, staging, marker } = siblings(join(root, 'Author', 'Title'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(backup, Buffer.from('not-a-directory'));
    await writeFile(marker, '');

    const error = await prepareImportSiblings({
      targetPath: target, libraryRoot: root, log: makeLog(),
    }).then(() => null, (e: unknown) => e);
    void staging;

    expect(error).toBeInstanceOf(BackupRecoveryError);
    const message = (error as BackupRecoveryError).message;
    expect(message).toContain(target);
    expect(message).toContain('.import-bak');
    expect(message).toMatch(/retr/i);
    expect(message).toMatch(/sweep/i);
  }));

  it('#1911 active recovery: marker + populated `.import-backup` restores originals, clears both conventions + marker', withTmp(async (root) => {
    const { target, activeStaging, activeBackup, marker } = siblings(join(root, 'Author', 'Title'));
    const originalBytes = Buffer.alloc(400, 9);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'new.m4b'), Buffer.from('STAGED-NEW'));
    await mkdir(activeBackup, { recursive: true });
    await writeFile(join(activeBackup, 'old.m4b'), originalBytes);
    await mkdir(activeStaging, { recursive: true });
    await writeFile(join(activeStaging, 'leftover.partial'), Buffer.from('scratch'));
    await writeFile(marker, '');

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old.m4b'))).toEqual(originalBytes);
    expect(await pathExists(marker)).toBe(false);
    expect(await pathExists(activeBackup)).toBe(false);
    expect(await pathExists(activeStaging)).toBe(false);
  }));

  it('#1911 F25(i): marker + populated LEGACY backup + populated ACTIVE staging → restores from legacy, clears the active staging too', withTmp(async (root) => {
    const { target, backup, activeStaging, activeBackup, marker } = siblings(join(root, 'Author', 'Title'));
    const bytes = Buffer.alloc(200, 3);
    await mkdir(target, { recursive: true });
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), bytes);
    await mkdir(activeStaging, { recursive: true });
    await writeFile(join(activeStaging, 'stale.m4b'), Buffer.from('STALE'));
    await writeFile(marker, '');

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
    expect(await pathExists(activeStaging)).toBe(false);
    expect(await pathExists(activeBackup)).toBe(false);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  }));

  it('#1911 F25(ii): marker + populated ACTIVE backup + populated LEGACY staging → restores from active, clears the un-dotted legacy staging (no ABS-visible survivor)', withTmp(async (root) => {
    const { target, staging, activeBackup, marker } = siblings(join(root, 'Author', 'Title'));
    const bytes = Buffer.alloc(200, 4);
    await mkdir(target, { recursive: true });
    await mkdir(activeBackup, { recursive: true });
    await writeFile(join(activeBackup, 'old.m4b'), bytes);
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'stale.m4b'), Buffer.from('STALE'));
    await writeFile(marker, '');

    const result = await sweepCommitPendingMarkers(root, makeLog());

    expect(result).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old.m4b'))).toEqual(bytes);
    expect(await pathExists(staging)).toBe(false);
    expect(await pathExists(activeBackup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  }));

  it('#1911 both-populated: throws ambiguity, preserves BOTH backups + marker, non-convergent, converges after operator removes one', withTmp(async (root) => {
    const { target, backup, activeBackup, marker } = siblings(join(root, 'Author', 'Title'));
    const legacyBytes = Buffer.alloc(120, 1);
    const activeBytes = Buffer.alloc(130, 2);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old-legacy.m4b'), legacyBytes);
    await mkdir(activeBackup, { recursive: true });
    await writeFile(join(activeBackup, 'old-active.m4b'), activeBytes);
    await writeFile(marker, '');

    const err = await prepareImportSiblings({ targetPath: target, libraryRoot: root, log: makeLog() })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BackupAmbiguityError);
    expect(await readFile(join(backup, 'old-legacy.m4b'))).toEqual(legacyBytes);
    expect(await readFile(join(activeBackup, 'old-active.m4b'))).toEqual(activeBytes);
    expect(await pathExists(marker)).toBe(true);

    const log = makeLog();
    const swept = await sweepCommitPendingMarkers(root, log);
    expect(swept.skipped).toEqual([marker]);
    expect(await pathExists(marker)).toBe(true);
    const warn = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      ([arg]) => arg && typeof arg === 'object' && (arg as { markerPath?: string }).markerPath === marker,
    );
    expect(warn).toBeDefined();
    const warnMeta = warn![0] as { activeBackupPath?: string; legacyBackupPath?: string };
    expect(warnMeta.activeBackupPath).toBe(activeBackup);
    expect(warnMeta.legacyBackupPath).toBe(backup);
    expect(String(warn![1])).not.toMatch(/retry on next boot/i);

    await rm(backup, { recursive: true, force: true });
    const after = await sweepCommitPendingMarkers(root, makeLog());
    expect(after).toEqual({ converged: 1, skipped: [] });
    expect(await readFile(join(target, 'old-active.m4b'))).toEqual(activeBytes);
    expect(await pathExists(marker)).toBe(false);
  }));

  it('#1911 F13: an ACTIVE-backup recovery failure names `.import-backup` in the message', withTmp(async (root) => {
    const { target, activeBackup, marker } = siblings(join(root, 'Author', 'Title'));
    await mkdir(dirname(target), { recursive: true });
    // A file at the active backup path forces ENOTDIR.
    await writeFile(activeBackup, Buffer.from('not-a-directory'));
    await writeFile(marker, '');

    const error = await prepareImportSiblings({ targetPath: target, libraryRoot: root, log: makeLog() })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(BackupRecoveryError);
    const message = (error as BackupRecoveryError).message;
    expect(message).toContain('.import-backup');
    expect((error as BackupRecoveryError).convention).toBe('active');
  }));

  it('#1911 AC6 cross-target: preparing visible `Title` touches ONLY Title-derived siblings; a foreign `.Title` legacy backup + marker survive', withTmp(async (root) => {
    const dir = join(root, 'Author');
    await mkdir(dir, { recursive: true });
    const visible = siblings(join(dir, 'Title'));
    const hidden = siblings(join(dir, '.Title'));
    // Seed foreign legacy state for a distinct dot-led target.
    const foreignBytes = Buffer.alloc(180, 6);
    await mkdir(hidden.backup, { recursive: true });
    await writeFile(join(hidden.backup, 'foreign.m4b'), foreignBytes);
    await writeFile(hidden.marker, '');
    await mkdir(visible.target, { recursive: true });

    await prepareImportSiblings({ targetPath: visible.target, libraryRoot: root, log: makeLog() });

    // Per-target sibling derivation must not touch the dot-led target's namespace.
    expect(await readFile(join(hidden.backup, 'foreign.m4b'))).toEqual(foreignBytes);
    expect(await pathExists(hidden.marker)).toBe(true);
  }));

  it('#1911 AC6 cross-target (symmetric): preparing hidden `.Title` leaves a foreign visible `Title` legacy backup + marker intact', withTmp(async (root) => {
    const dir = join(root, 'Author');
    await mkdir(dir, { recursive: true });
    const visible = siblings(join(dir, 'Title'));
    const hidden = siblings(join(dir, '.Title'));
    const foreignBytes = Buffer.alloc(190, 7);
    await mkdir(visible.backup, { recursive: true });
    await writeFile(join(visible.backup, 'foreign.m4b'), foreignBytes);
    await writeFile(visible.marker, '');
    await mkdir(hidden.target, { recursive: true });

    await prepareImportSiblings({ targetPath: hidden.target, libraryRoot: root, log: makeLog() });

    expect(await readFile(join(visible.backup, 'foreign.m4b'))).toEqual(foreignBytes);
    expect(await pathExists(visible.marker)).toBe(true);
  }));

  it('#1911 findCommitPendingMarkers: an ACTIVE dotted scratch sibling beside its live (un-dotted) marker is pruned', withTmp(async (root) => {
    // The sibling marker identifies dot-led active scratch and prunes its decoy.
    const { activeStaging, marker } = siblings(join(root, 'Author', 'Title'));
    await mkdir(activeStaging, { recursive: true });
    await writeFile(join(activeStaging, 'decoy.import-commit-pending'), '');
    await writeFile(marker, '');

    expect(await findCommitPendingMarkers(root)).toEqual([marker]);
  }));

  it('#1911 AC13 findCommitPendingMarkers: a HIDDEN-target legacy scratch (`.Title.import-bak` beside `.Title.import-commit-pending`) is pruned, its decoy subtree not collected', withTmp(async (root) => {
    // Pair hidden-target legacy scratch with the marker sharing its dot-led basename.
    const author = join(root, 'Author');
    await mkdir(author, { recursive: true });
    const legacyBackup = join(author, '.Title.import-bak');
    const liveMarker = join(author, '.Title.import-commit-pending');
    await mkdir(legacyBackup, { recursive: true });
    await writeFile(join(legacyBackup, 'decoy.import-commit-pending'), '');
    await writeFile(liveMarker, '');

    expect(await findCommitPendingMarkers(root)).toEqual([liveMarker]);
  }));
});
