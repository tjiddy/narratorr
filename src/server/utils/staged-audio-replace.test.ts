import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { stagedAudioReplace, prepareImportSiblings, BackupRecoveryError, markerPresent, MarkerPathConflictError } from './import-steps.js';
import { copyAudioFiles, copyDiscGroup, getAudioPathSize } from './import-helpers.js';

/**
 * #1287 — the manual-import path must NOT merge a new audio edition into a target
 * that already contains audio (that recreates the #1252 Frankenbook). These tests
 * exercise the real staged-swap (`stagedAudioReplace` → `commitStagedImport`) over
 * a real tmpdir so the byte-level "clean audio replace, non-audio preserved,
 * atomic on failure" contract is asserted directly.
 */

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

/** Recursively list every file path relative to `dir`, POSIX-normalized. */
async function listAllFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listAllFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

describe('stagedAudioReplace (#1287 manual import over populated target)', () => {
  let libraryRoot: string;
  let target: string;
  let source: string;

  beforeEach(async () => {
    libraryRoot = mkdtempSync(join(tmpdir(), 'narratorr-1287-'));
    target = join(libraryRoot, 'Author', 'Title');
    source = join(libraryRoot, '_downloads', 'release');
    await mkdir(target, { recursive: true });
    await mkdir(source, { recursive: true });
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  async function replaceFromSource(): Promise<void> {
    const sourceAudioSize = await getAudioPathSize(source);
    await stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize,
      stage: (stagingPath) => copyAudioFiles(source, stagingPath),
    });
  }

  it('AC1: replaces a stale .m4b with a 3-file mp3 edition — no mixed-edition Frankenbook', async () => {
    await writeFile(join(target, 'Finders Keepers.m4b'), Buffer.alloc(500, 1));
    for (const name of ['a.mp3', 'b.mp3', 'c.mp3']) {
      await writeFile(join(source, name), Buffer.alloc(200, 2));
    }

    await replaceFromSource();

    expect(await listAllFiles(target)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
    // Transient siblings cleaned up.
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('AC1: preserves pre-existing non-audio (cover.jpg / .nfo) while replacing audio', async () => {
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(target, 'cover.jpg'), Buffer.from('JPEGDATA'));
    await writeFile(join(target, 'book.nfo'), Buffer.from('<nfo/>'));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await replaceFromSource();

    const files = await listAllFiles(target);
    expect(files).toContain('new.mp3');
    expect(files).toContain('cover.jpg');
    expect(files).toContain('book.nfo');
    expect(files).not.toContain('old.m4b');
    // Non-audio bytes untouched.
    expect(await readFile(join(target, 'cover.jpg'), 'utf8')).toBe('JPEGDATA');
  });

  it('AC7: removes existing audio nested under subdirectories, preserving nested non-audio', async () => {
    await mkdir(join(target, 'Disc 1'), { recursive: true });
    await writeFile(join(target, 'Disc 1', 'old.mp3'), Buffer.alloc(500, 1));
    await writeFile(join(target, 'Disc 1', 'disc.nfo'), Buffer.from('nested-nfo'));
    await writeFile(join(target, 'cover.jpg'), Buffer.from('JPEGDATA'));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await replaceFromSource();

    const files = await listAllFiles(target);
    // No audio survives anywhere — top-level or nested.
    expect(files.filter((f) => f.endsWith('.mp3'))).toEqual(['new.mp3']);
    expect(files).not.toContain('Disc 1/old.mp3');
    // Nested + top-level non-audio preserved.
    expect(files).toContain('Disc 1/disc.nfo');
    expect(files).toContain('cover.jpg');
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('AC4: a byte-identical re-import yields a single clean copy — no dupe, no throw', async () => {
    const bytes = Buffer.alloc(400, 7);
    await writeFile(join(target, 'book.mp3'), bytes);
    await writeFile(join(source, 'book.mp3'), bytes);

    await replaceFromSource();

    expect(await listAllFiles(target)).toEqual(['book.mp3']);
    expect(await readFile(join(target, 'book.mp3'))).toEqual(bytes);
  });

  it('AC2: a mid-copy staging failure leaves the existing target audio byte-unchanged and no siblings', async () => {
    const originalBytes = Buffer.alloc(500, 1);
    await writeFile(join(target, 'old.m4b'), originalBytes);
    await writeFile(join(target, 'cover.jpg'), Buffer.from('JPEGDATA'));

    await expect(stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize: 1000,
      stage: async (stagingPath) => {
        // Simulate a copy that fails partway: write a partial staged file, then throw.
        await mkdir(stagingPath, { recursive: true });
        await writeFile(join(stagingPath, 'partial.mp3'), Buffer.alloc(50));
        throw new Error('Disk full mid-copy');
      },
    })).rejects.toThrow('Disk full mid-copy');

    // Existing target audio is exactly as it was — never touched.
    expect(await listAllFiles(target)).toEqual(['cover.jpg', 'old.m4b']);
    expect(await readFile(join(target, 'old.m4b'))).toEqual(originalBytes);
    // The partial staging dir is cleaned up.
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('AC6: flattens nested source audio into the target top level, nothing stranded in staging', async () => {
    await writeFile(join(target, 'old.mp3'), Buffer.alloc(300, 1));
    await mkdir(join(source, 'Disc 1'), { recursive: true });
    await mkdir(join(source, 'Disc 2'), { recursive: true });
    await writeFile(join(source, 'Disc 1', 'track.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(source, 'Disc 2', 'track.mp3'), Buffer.alloc(300, 2));

    await replaceFromSource();

    const files = await listAllFiles(target);
    // Two discs flattened + sequentially renamed to the top level; old audio gone.
    expect(files).not.toContain('old.mp3');
    expect(files.every((f) => !f.includes('/'))).toBe(true);
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
  });

  it('AC6: colliding source basenames abort before the populated target is touched', async () => {
    const originalBytes = Buffer.alloc(300, 1);
    await writeFile(join(target, 'old.mp3'), originalBytes);
    // Two non-disc subfolders each with the same basename → flatten collision throw.
    await mkdir(join(source, 'A'), { recursive: true });
    await mkdir(join(source, 'B'), { recursive: true });
    await writeFile(join(source, 'A', '01.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(source, 'B', '01.mp3'), Buffer.alloc(300, 2));

    await expect(replaceFromSource()).rejects.toThrow(/Duplicate filename/i);

    // Pre-existing target audio is byte-unchanged — the throw happened during staging.
    expect(await listAllFiles(target)).toEqual(['old.mp3']);
    expect(await readFile(join(target, 'old.mp3'))).toEqual(originalBytes);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
  });

  it('AC5: disc-group flatten over a populated target replaces cleanly via the staged swap', async () => {
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(300, 1));
    const disc1 = join(libraryRoot, '_downloads', 'Book Disc 1 of 2');
    const disc2 = join(libraryRoot, '_downloads', 'Book Disc 2 of 2');
    await mkdir(disc1, { recursive: true });
    await mkdir(disc2, { recursive: true });
    await writeFile(join(disc1, 'd1.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(disc2, 'd2.mp3'), Buffer.alloc(300, 2));

    const members = [disc1, disc2];
    let sourceAudioSize = 0;
    for (const m of members) sourceAudioSize += await getAudioPathSize(m);
    await stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize,
      stage: (stagingPath) => copyDiscGroup(members, stagingPath),
    });

    const files = await listAllFiles(target);
    expect(files).not.toContain('old.m4b');
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('#1290: a successful replace over a populated target leaves no commit-pending marker behind', async () => {
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await replaceFromSource();

    expect(await pathExists(`${target}.import-commit-pending`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });
});

/**
 * #1290 — a process-killed commit (SIGKILL/OOM/power loss) leaves originals stranded
 * in `.import-bak` and a commit-pending marker on disk; the in-process rollback never
 * ran. On the next import the marker drives recovery: the originals are restored to the
 * target before any deletion, instead of the prior strict-clear that deleted them.
 * These tests stage that interrupted on-disk state over a real tmpdir and drive the
 * real entry path (`prepareImportSiblings` / `stagedAudioReplace`).
 */
describe('interrupted-commit recovery (#1290 marker-gated restore)', () => {
  let libraryRoot: string;
  let target: string;
  let staging: string;
  let backup: string;
  let marker: string;

  beforeEach(async () => {
    libraryRoot = mkdtempSync(join(tmpdir(), 'narratorr-1290-'));
    target = join(libraryRoot, 'Author', 'Title');
    staging = `${target}.import-tmp`;
    backup = `${target}.import-bak`;
    marker = `${target}.import-commit-pending`;
    await mkdir(target, { recursive: true });
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  /** Re-enter the import pre-step exactly as the startup-recovery re-run would. */
  function recover(): Promise<void> {
    return prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot, log: makeLog() });
  }

  it('AC: restores a flat backed-up original into the target, then clears backup + marker', async () => {
    const originalBytes = Buffer.alloc(400, 9);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), originalBytes);
    await writeFile(marker, '');

    await recover();

    expect(await readFile(join(target, 'old.m4b'))).toEqual(originalBytes);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  });

  it('AC: detects + restores nested-only backups (Disc 1/old.mp3), recreating the subdir', async () => {
    const bytes = Buffer.alloc(300, 3);
    await mkdir(join(backup, 'Disc 1'), { recursive: true });
    await mkdir(join(backup, 'Disc 2'), { recursive: true });
    await writeFile(join(backup, 'Disc 1', 'track01.mp3'), bytes);
    await writeFile(join(backup, 'Disc 2', 'track02.mp3'), bytes);
    await writeFile(marker, '');

    await recover();

    const files = await listAllFiles(target);
    expect(files).toContain('Disc 1/track01.mp3');
    expect(files).toContain('Disc 2/track02.mp3');
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  });

  it('AC: interrupted move-in conflict — backup overwrites the half-moved-in same-name target file', async () => {
    const original = Buffer.from('ORIGINAL-EDITION');
    const halfMovedIn = Buffer.from('STAGED-NEW-EDITION');
    // A kill mid move-in: the new staged file already sits at target/book.m4b...
    await writeFile(join(target, 'book.m4b'), halfMovedIn);
    // ...while the original is in the backup, and the marker proves the interruption.
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'book.m4b'), original);
    await writeFile(marker, '');

    await recover();

    // The backup is authoritative: the original overwrites the half-moved-in file.
    expect(await readFile(join(target, 'book.m4b'))).toEqual(original);
  });

  it('AC (gap 3): recovery overwrites the colliding half-moved-in file but does NOT delete a non-colliding moved-in new-edition file', async () => {
    // The interrupted-conflict AC has TWO halves. The colliding half (backup overwrites a
    // same-name half-moved-in file) is pinned above; this pins the OTHER half: a new-edition
    // file that was moved into the target with NO backup counterpart must SURVIVE recovery —
    // recovery only restores backed-up relative paths, it never sweeps the target clean.
    const original = Buffer.from('ORIGINAL-EDITION');
    const halfMovedColliding = Buffer.from('STAGED-NEW-SAME-NAME');
    const nonCollidingNew = Buffer.from('STAGED-NEW-NO-BACKUP-COUNTERPART');
    // Half-moved-in new edition: book.mp3 collides with the backup; bonus.mp3 does not.
    await writeFile(join(target, 'book.mp3'), halfMovedColliding);
    await writeFile(join(target, 'bonus.mp3'), nonCollidingNew);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'book.mp3'), original);
    await writeFile(marker, '');

    await recover();

    // Colliding half: the backup is authoritative, overwriting the half-moved-in same-name file.
    expect(await readFile(join(target, 'book.mp3'))).toEqual(original);
    // Non-colliding half: the moved-in new-edition file with no backup counterpart SURVIVES —
    // a regression that swept the target during recovery would delete it and fail here.
    expect(await readFile(join(target, 'bonus.mp3'))).toEqual(nonCollidingNew);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  });

  it('AC (gap 2): marker-present recovery runs as a PRE-STEP of a completing import — real stage() copies the new edition, whose bytes win end-to-end', async () => {
    // Existing coverage drives recovery via `prepareImportSiblings` in isolation. This pins the
    // full chain: an interrupted on-disk state (marker + stranded original) feeds a real
    // `stagedAudioReplace` whose `stage()` copies a NEW edition — recovery restores the original
    // first, then the swap replaces it. The new edition's bytes must win at the end.
    const oldBytes = Buffer.from('OLD-EDITION-STRANDED');
    const newBytes = Buffer.alloc(600, 7);
    // Interrupted-commit shape: original stranded in the backup, marker present, target empty of audio.
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), oldBytes);
    await writeFile(marker, '');
    // The new edition to import.
    const source = join(libraryRoot, '_downloads', 'release');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'new.mp3'), newBytes);

    const sourceAudioSize = await getAudioPathSize(source);
    await stagedAudioReplace({
      targetPath: target, libraryRoot, log: makeLog(), sourceAudioSize,
      stage: (stagingPath) => copyAudioFiles(source, stagingPath),
    });

    // Recovery ran as a pre-step, THEN the new edition replaced the recovered original end-to-end.
    expect(await listAllFiles(target)).toEqual(['new.mp3']);
    expect(await readFile(join(target, 'new.mp3'))).toEqual(newBytes);
    // No stale old edition survives, and no leftover siblings/marker remain.
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
    expect(await pathExists(staging)).toBe(false);
  });

  it('AC: leaves non-audio in the target untouched while restoring backed-up audio', async () => {
    await writeFile(join(target, 'cover.jpg'), Buffer.from('JPEGDATA'));
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), Buffer.alloc(200, 1));
    await writeFile(marker, '');

    await recover();

    expect(await readFile(join(target, 'cover.jpg'), 'utf8')).toBe('JPEGDATA');
    expect(await pathExists(join(target, 'old.m4b'))).toBe(true);
  });

  it('AC (idempotency): a recovery failure preserves the unrestored backup + marker; a second run converges', async () => {
    const aBytes = Buffer.from('A-ORIGINAL');
    const zBytes = Buffer.from('Z-ORIGINAL');
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'a.m4b'), aBytes);
    await writeFile(join(backup, 'z.m4b'), zBytes);
    await writeFile(marker, '');
    // Block the restore of z.m4b: a non-empty directory at the destination makes the
    // file→dir rename throw partway through the restore loop.
    await mkdir(join(target, 'z.m4b'), { recursive: true });
    await writeFile(join(target, 'z.m4b', 'blocker'), Buffer.from('x'));

    // Drive the full caller chain so the preserve-backup cleanup path is exercised.
    await expect(stagedAudioReplace({
      targetPath: target, libraryRoot, log: makeLog(), sourceAudioSize: 1,
      stage: async () => { /* unreached — recovery throws first */ },
    })).rejects.toBeInstanceOf(BackupRecoveryError);

    // The unrestored original AND the marker survive for the next boot.
    expect(await pathExists(join(backup, 'z.m4b'))).toBe(true);
    expect(await pathExists(marker)).toBe(true);

    // Next boot: clear the blocker, re-run recovery → converges, both files restored.
    await rm(join(target, 'z.m4b'), { recursive: true, force: true });
    await recover();

    expect(await readFile(join(target, 'a.m4b'))).toEqual(aBytes);
    expect(await readFile(join(target, 'z.m4b'))).toEqual(zBytes);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  });

  it('#1336 window 1: a recovery-enumeration readdir error preserves .import-bak + the marker', async () => {
    // Marker present, but `.import-bak` cannot be enumerated as a directory — here it is a
    // plain FILE, so `listAudioFilesRecursive` → `readdir` rejects with ENOTDIR (a non-ENOENT
    // error). The enumeration now sits INSIDE recoverInterruptedBackup's wrapping try (#1336),
    // so it surfaces as a BackupRecoveryError and the cleanup preserves both — instead of the
    // raw readdir error propagating to cleanup and deleting the stranded originals. Moving the
    // enumeration back outside the try would let the raw ENOTDIR escape and fail this test.
    await writeFile(backup, Buffer.from('not-a-directory')); // `.import-bak` as a file → readdir ENOTDIR
    await writeFile(marker, '');

    await expect(stagedAudioReplace({
      targetPath: target, libraryRoot, log: makeLog(), sourceAudioSize: 1,
      stage: async () => { /* unreached — recovery enumeration throws first */ },
    })).rejects.toBeInstanceOf(BackupRecoveryError);

    // Both survive for the next boot's recovery attempt — nothing was deleted.
    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(backup)).toBe(true);
  });

  it('#1336: a plain commit failure leaves the marker on disk → .import-bak + marker preserved (identity-independent)', async () => {
    // Drive a real commit failure over a populated target: the staged file move-in fails
    // because a non-empty directory squats at its destination path. commitStagedImport
    // rolls back and rethrows the ORIGINAL (plain) error — NOT a BackupRecoveryError — with
    // the commit-pending marker still on disk. The catch's cleanup must key on the marker's
    // disk presence (#1336), not the error's identity, and preserve the backup + marker.
    await writeFile(join(target, 'old.mp3'), Buffer.alloc(300, 1));
    // A directory at target/new.mp3 makes the staged file→target rename fail mid-commit.
    await mkdir(join(target, 'new.mp3'), { recursive: true });
    await writeFile(join(target, 'new.mp3', 'blocker'), Buffer.from('x'));

    const stagedBytes = Buffer.alloc(300, 2);
    const error = await stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize: stagedBytes.length,
      stage: async (stagingPath) => {
        await mkdir(stagingPath, { recursive: true });
        await writeFile(join(stagingPath, 'new.mp3'), stagedBytes);
      },
    }).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BackupRecoveryError);

    // The marker survives, and the backup is NOT deleted while the marker is present.
    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(backup)).toBe(true);
  });

  it('false-positive guard: a stale non-empty .import-bak with NO marker is strict-cleared, target NOT regressed', async () => {
    const committedBytes = Buffer.from('NEW-COMMITTED');
    const staleBytes = Buffer.from('OLD-STALE');
    // Success-leftover shape: target holds the correctly committed new audio, the
    // backup holds stale old audio, and there is NO marker.
    await writeFile(join(target, 'book.m4b'), committedBytes);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'book.m4b'), staleBytes);

    const log = makeLog();
    await prepareImportSiblings({ stagingPath: staging, targetPath: target, backupPath: backup, libraryRoot, log });

    // Backup strict-cleared, committed target audio untouched, no recovery log.
    expect(await pathExists(backup)).toBe(false);
    expect(await readFile(join(target, 'book.m4b'))).toEqual(committedBytes);
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Recovering interrupted import commit/i));
  });

  it('negative twin: empty .import-bak with no marker → no recovery, backup cleared', async () => {
    await mkdir(backup, { recursive: true });

    await recover();

    expect(await pathExists(backup)).toBe(false);
  });

  it('negative twin: absent .import-bak with no marker → happy path, nothing restored', async () => {
    await writeFile(join(target, 'keep.jpg'), Buffer.from('cover'));

    await recover();

    // Target untouched; no backup conjured.
    expect(await listAllFiles(target)).toEqual(['keep.jpg']);
    expect(await pathExists(backup)).toBe(false);
  });

  it('negative twin: a populated .import-tmp is cleared unconditionally, never restored into target', async () => {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'scratch.mp3'), Buffer.alloc(100, 5));

    await recover();

    expect(await pathExists(staging)).toBe(false);
    expect(await pathExists(join(target, 'scratch.mp3'))).toBe(false);
  });
});

/**
 * #1341 — a metadata-derived folder can collide with the commit-pending marker path, so a
 * DIRECTORY (or any non-file) sits at `<target>.import-commit-pending`. Reads must treat it
 * as marker-absent, but a full import must ABORT before any destructive sibling clearing —
 * never strict-clearing an adjacent pre-existing `.import-bak` nor raising a raw EISDIR.
 */
describe('marker-path directory collision (#1341)', () => {
  let libraryRoot: string;
  let target: string;
  let source: string;

  beforeEach(async () => {
    libraryRoot = mkdtempSync(join(tmpdir(), 'narratorr-1341-'));
    target = join(libraryRoot, 'Author', 'Title');
    source = join(libraryRoot, '_downloads', 'release');
    await mkdir(target, { recursive: true });
    await mkdir(source, { recursive: true });
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it('markerPresent reads a DIRECTORY at the marker path as marker-absent (false)', async () => {
    await mkdir(`${target}.import-commit-pending`, { recursive: true });

    // Verified through the exported read-side caller, not the private markerExists.
    expect(await markerPresent(target, makeLog())).toBe(false);
  });

  it('full-flow abort: throws MarkerPathConflictError, leaves an adjacent .import-bak + target audio intact, never stages', async () => {
    const targetBytes = Buffer.from('TARGET-AUDIO');
    const bakBytes = Buffer.from('REAL-BOOK-IN-BAK');
    await writeFile(join(target, 'existing.mp3'), targetBytes);
    // A DIRECTORY squats at the marker path (metadata collision).
    await mkdir(`${target}.import-commit-pending`, { recursive: true });
    // A real adjacent pre-existing `.import-bak` holding a real book's audio.
    await mkdir(`${target}.import-bak`, { recursive: true });
    await writeFile(join(`${target}.import-bak`, 'realbook.mp3'), bakBytes);

    let staged = false;
    await expect(stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize: 200,
      stage: async (stagingPath) => {
        staged = true;
        await mkdir(stagingPath, { recursive: true });
        await writeFile(join(stagingPath, 'new.mp3'), Buffer.alloc(200, 2));
      },
    })).rejects.toBeInstanceOf(MarkerPathConflictError);

    // Aborted at the preflight — staging never ran.
    expect(staged).toBe(false);
    // The adjacent pre-existing `.import-bak` audio survives intact — not strict-cleared,
    // not soft-removed by failure cleanup.
    expect(await readFile(join(`${target}.import-bak`, 'realbook.mp3'))).toEqual(bakBytes);
    // Existing target audio is byte-unchanged and no `.import-tmp` was committed.
    expect(await readFile(join(target, 'existing.mp3'))).toEqual(targetBytes);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
  });

  it('preservation: a genuine non-ENOENT marker stat error still returns true from markerPresent (#1336)', async () => {
    // An ancestor that is a FILE makes stat on the derived marker path throw ENOTDIR (a
    // non-ENOENT error) — markerPresent must fail toward preservation and return true.
    const ancestorFile = join(libraryRoot, 'AuthorAsFile');
    await writeFile(ancestorFile, 'x');
    const wedgedTarget = join(ancestorFile, 'Title');

    expect(await markerPresent(wedgedTarget, makeLog())).toBe(true);
  });

  it('happy-path regression: a normal replace (no collision) writes then removes the marker and swaps cleanly', async () => {
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(300, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(300, 2));

    const sourceAudioSize = await getAudioPathSize(source);
    await stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize,
      stage: (stagingPath) => copyAudioFiles(source, stagingPath),
    });

    expect(await listAllFiles(target)).toEqual(['new.mp3']);
    expect(await pathExists(`${target}.import-commit-pending`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });
});
