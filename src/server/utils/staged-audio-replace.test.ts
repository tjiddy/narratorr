import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { stagedAudioReplace, prepareImportSiblings, BackupRecoveryError, markerPresent, MarkerPathConflictError } from './import-steps.js';
import { deriveImportSiblings } from './import-sibling-paths.js';
import { copyAudioFiles, copyDiscGroup, getAudioPathSize } from './import-helpers.js';

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

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
    const { stagingPath, backupPath, legacyStagingPath, legacyBackupPath } = deriveImportSiblings(target);
    expect(await pathExists(stagingPath)).toBe(false);
    expect(await pathExists(backupPath)).toBe(false);
    expect(await pathExists(legacyStagingPath)).toBe(false);
    expect(await pathExists(legacyBackupPath)).toBe(false);
  });

  it('#1911: stages into a dot-led `.import-staging` dir (born hidden), commits audio into the visible target, scratch gone after', async () => {
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));
    const { stagingPath, backupPath } = deriveImportSiblings(target);

    let observedStagingBasename: string | undefined;
    let stagingWasDotLedDuringStage = false;
    await stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize: await getAudioPathSize(source),
      stage: async (sp) => {
        // basename keeps the dot-led check platform-independent.
        observedStagingBasename = basename(sp);
        await copyAudioFiles(source, sp);
        stagingWasDotLedDuringStage = await pathExists(sp) && observedStagingBasename!.startsWith('.');
      },
    });

    expect(basename(stagingPath)).toMatch(/^\.Title\.import-staging$/);
    expect(stagingWasDotLedDuringStage).toBe(true);
    expect(await listAllFiles(target)).toContain('new.mp3');
    expect(await pathExists(stagingPath)).toBe(false);
    expect(await pathExists(backupPath)).toBe(false);
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
    expect(files.filter((f) => f.endsWith('.mp3'))).toEqual(['new.mp3']);
    expect(files).not.toContain('Disc 1/old.mp3');
    expect(files).toContain('Disc 1/disc.nfo');
    expect(files).toContain('cover.jpg');
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('#1852 F8: the staged swap never backs up or removes a hidden target temp or a hidden subtree (backup enumeration skips them)', async () => {
    await writeFile(join(target, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(target, '.active.tmp.mp3'), Buffer.alloc(300, 9));
    await mkdir(join(target, '.staging'), { recursive: true });
    await writeFile(join(target, '.staging', 'ghost.mp3'), Buffer.alloc(200, 8));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await replaceFromSource();

    const files = await listAllFiles(target);
    expect(files).toContain('new.mp3');
    expect(files).not.toContain('old.m4b');
    expect(files).toContain('.active.tmp.mp3');
    expect(files).toContain('.staging/ghost.mp3');
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('#1852 F11: a hidden target ROOT is an identity root — its visible audio is enumerated, backed up, and replaced', async () => {
    // Hidden roots are descended; only hidden descendants are skipped.
    const hiddenTarget = join(libraryRoot, 'Author', '.Title');
    await mkdir(hiddenTarget, { recursive: true });
    await writeFile(join(hiddenTarget, 'old.m4b'), Buffer.alloc(500, 1));
    await writeFile(join(source, 'new.mp3'), Buffer.alloc(500, 2));

    await stagedAudioReplace({
      targetPath: hiddenTarget,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize: await getAudioPathSize(source),
      stage: (stagingPath) => copyAudioFiles(source, stagingPath),
    });

    const files = await listAllFiles(hiddenTarget);
    expect(files).toContain('new.mp3');
    expect(files).not.toContain('old.m4b');
    expect(await pathExists(`${hiddenTarget}.import-bak`)).toBe(false);
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
        // Simulate a partial staged file before the copy fails.
        await mkdir(stagingPath, { recursive: true });
        await writeFile(join(stagingPath, 'partial.mp3'), Buffer.alloc(50));
        throw new Error('Disk full mid-copy');
      },
    })).rejects.toThrow('Disk full mid-copy');

    expect(await listAllFiles(target)).toEqual(['cover.jpg', 'old.m4b']);
    expect(await readFile(join(target, 'old.m4b'))).toEqual(originalBytes);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  it('#2495: stages and commits a bare .mp4 over a stale target', async () => {
    await writeFile(join(target, 'stale.m4b'), Buffer.alloc(500, 1));
    const mp4Bytes = Buffer.alloc(400, 7);
    await writeFile(join(source, 'FortuneFunhouseMissFortuneMysteriesBook19.mp4'), mp4Bytes);

    await replaceFromSource();

    expect(await listAllFiles(target)).toEqual(['FortuneFunhouseMissFortuneMysteriesBook19.mp4']);
    expect(await readFile(join(target, 'FortuneFunhouseMissFortuneMysteriesBook19.mp4'))).toEqual(mp4Bytes);
    const { stagingPath, backupPath } = deriveImportSiblings(target);
    expect(await pathExists(stagingPath)).toBe(false);
    expect(await pathExists(backupPath)).toBe(false);
  });

  it('#2495: a mid-stage failure leaves the prior .mp4 target untouched and clears the scratch', async () => {
    const originalBytes = Buffer.alloc(500, 3);
    await writeFile(join(target, 'Existing.mp4'), originalBytes);

    await expect(stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log: makeLog(),
      sourceAudioSize: 1000,
      stage: async (stagingPath) => {
        await mkdir(stagingPath, { recursive: true });
        await writeFile(join(stagingPath, 'Replacement.mp4'), Buffer.alloc(400, 9));
        throw new Error('Disk full mid-copy');
      },
    })).rejects.toThrow('Disk full mid-copy');

    expect(await listAllFiles(target)).toEqual(['Existing.mp4']);
    expect(await readFile(join(target, 'Existing.mp4'))).toEqual(originalBytes);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
    expect(await pathExists(`${target}.import-bak`)).toBe(false);
  });

  /**
   * The twin of the case above, on the far side of the destructive step: the existing `.mp4` has
   * already been renamed into `.import-bak` when the commit fails, so this is the arm that actually
   * exercises restoration rather than scratch cleanup. A non-empty directory standing where a
   * staged file must land is this suite's established way to fail one rename mid-commit.
   */
  it('#2495: a commit-time failure restores the backed-up .mp4 byte-for-byte', async () => {
    const originalBytes = Buffer.from('ORIGINAL-MP4-PAYLOAD');
    const stagedBytes = Buffer.from('REPLACEMENT-MP4-PAYLOAD');
    await writeFile(join(target, 'Existing.mp4'), originalBytes);
    await mkdir(join(target, 'Replacement.mp4'), { recursive: true });
    await writeFile(join(target, 'Replacement.mp4', 'blocker'), Buffer.from('x'));
    const log = makeLog();

    const error = await stagedAudioReplace({
      targetPath: target,
      libraryRoot,
      log,
      sourceAudioSize: stagedBytes.length,
      stage: async (stagingPath) => {
        await mkdir(stagingPath, { recursive: true });
        await writeFile(join(stagingPath, 'Replacement.mp4'), stagedBytes);
      },
    }).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BackupRecoveryError);

    // Only commitStagedImport's own catch logs this, so it proves the run reached the destructive
    // phase — the whole point of the case. Staged-size verification passing is the second proof:
    // it reads getAudioPathSize over the staging dir, which counts the `.mp4` as audio.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: target }),
      'Import commit failed — rolling back to pre-import state',
    );

    // The data-preserving contract: the pre-import copy is back, byte for byte.
    expect(await readFile(join(target, 'Existing.mp4'))).toEqual(originalBytes);
    // The staged replacement never became the target's audio — the blocker dir still stands.
    expect((await stat(join(target, 'Replacement.mp4'))).isDirectory()).toBe(true);

    // A failed commit keeps the marker and the backup so recovery can converge on the next run.
    const { backupPath, markerPath } = deriveImportSiblings(target);
    expect(await pathExists(markerPath)).toBe(true);
    expect(await pathExists(backupPath)).toBe(true);
  });

  it('AC6: flattens nested source audio into the target top level, nothing stranded in staging', async () => {
    await writeFile(join(target, 'old.mp3'), Buffer.alloc(300, 1));
    await mkdir(join(source, 'Disc 1'), { recursive: true });
    await mkdir(join(source, 'Disc 2'), { recursive: true });
    await writeFile(join(source, 'Disc 1', 'track.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(source, 'Disc 2', 'track.mp3'), Buffer.alloc(300, 2));

    await replaceFromSource();

    const files = await listAllFiles(target);
    expect(files).not.toContain('old.mp3');
    expect(files.every((f) => !f.includes('/'))).toBe(true);
    expect(files.filter((f) => f.endsWith('.mp3'))).toHaveLength(2);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
  });

  it('AC6: colliding source basenames abort before the populated target is touched', async () => {
    const originalBytes = Buffer.alloc(300, 1);
    await writeFile(join(target, 'old.mp3'), originalBytes);
    await mkdir(join(source, 'A'), { recursive: true });
    await mkdir(join(source, 'B'), { recursive: true });
    await writeFile(join(source, 'A', '01.mp3'), Buffer.alloc(300, 2));
    await writeFile(join(source, 'B', '01.mp3'), Buffer.alloc(300, 2));

    await expect(replaceFromSource()).rejects.toThrow(/Duplicate filename/i);

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

// A durable marker makes stranded originals authoritative after process death.
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

  /** Legacy-seeded fixtures exercise legacy recognition through the real pre-step. */
  function recover(): Promise<void> {
    return prepareImportSiblings({ targetPath: target, libraryRoot, log: makeLog() });
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

  it('#1852 F8: recovery restores visible backed-up audio but never restores a hidden entry stranded in .import-bak', async () => {
    const originalBytes = Buffer.alloc(400, 9);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), originalBytes);
    await writeFile(join(backup, '.ghost.tmp.mp3'), Buffer.alloc(100, 7));
    await writeFile(marker, '');

    await recover();

    expect(await readFile(join(target, 'old.m4b'))).toEqual(originalBytes);
    expect(await pathExists(join(target, '.ghost.tmp.mp3'))).toBe(false);
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
    await writeFile(join(target, 'book.m4b'), halfMovedIn);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'book.m4b'), original);
    await writeFile(marker, '');

    await recover();

    expect(await readFile(join(target, 'book.m4b'))).toEqual(original);
  });

  it('AC (gap 3): recovery overwrites the colliding half-moved-in file but does NOT delete a non-colliding moved-in new-edition file', async () => {
    // Recovery restores backup collisions but never sweeps unrelated moved-in files.
    const original = Buffer.from('ORIGINAL-EDITION');
    const halfMovedColliding = Buffer.from('STAGED-NEW-SAME-NAME');
    const nonCollidingNew = Buffer.from('STAGED-NEW-NO-BACKUP-COUNTERPART');
    await writeFile(join(target, 'book.mp3'), halfMovedColliding);
    await writeFile(join(target, 'bonus.mp3'), nonCollidingNew);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'book.mp3'), original);
    await writeFile(marker, '');

    await recover();

    expect(await readFile(join(target, 'book.mp3'))).toEqual(original);
    expect(await readFile(join(target, 'bonus.mp3'))).toEqual(nonCollidingNew);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  });

  it('AC (gap 2): marker-present recovery runs as a PRE-STEP of a completing import — real stage() copies the new edition, whose bytes win end-to-end', async () => {
    // Pin recovery-before-swap through the full stagedAudioReplace chain.
    const oldBytes = Buffer.from('OLD-EDITION-STRANDED');
    const newBytes = Buffer.alloc(600, 7);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'old.m4b'), oldBytes);
    await writeFile(marker, '');
    const source = join(libraryRoot, '_downloads', 'release');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'new.mp3'), newBytes);

    const sourceAudioSize = await getAudioPathSize(source);
    await stagedAudioReplace({
      targetPath: target, libraryRoot, log: makeLog(), sourceAudioSize,
      stage: (stagingPath) => copyAudioFiles(source, stagingPath),
    });

    expect(await listAllFiles(target)).toEqual(['new.mp3']);
    expect(await readFile(join(target, 'new.mp3'))).toEqual(newBytes);
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
    // A non-empty destination directory fails one restore mid-loop.
    await mkdir(join(target, 'z.m4b'), { recursive: true });
    await writeFile(join(target, 'z.m4b', 'blocker'), Buffer.from('x'));

    await expect(stagedAudioReplace({
      targetPath: target, libraryRoot, log: makeLog(), sourceAudioSize: 1,
      stage: async () => {},
    })).rejects.toBeInstanceOf(BackupRecoveryError);

    expect(await pathExists(join(backup, 'z.m4b'))).toBe(true);
    expect(await pathExists(marker)).toBe(true);

    await rm(join(target, 'z.m4b'), { recursive: true, force: true });
    await recover();

    expect(await readFile(join(target, 'a.m4b'))).toEqual(aBytes);
    expect(await readFile(join(target, 'z.m4b'))).toEqual(zBytes);
    expect(await pathExists(backup)).toBe(false);
    expect(await pathExists(marker)).toBe(false);
  });

  it('#1336 window 1: a recovery-enumeration readdir error preserves .import-bak + the marker', async () => {
    // An ENOTDIR backup enumeration must become a preservation error.
    await writeFile(backup, Buffer.from('not-a-directory'));
    await writeFile(marker, '');

    await expect(stagedAudioReplace({
      targetPath: target, libraryRoot, log: makeLog(), sourceAudioSize: 1,
      stage: async () => {},
    })).rejects.toBeInstanceOf(BackupRecoveryError);

    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(backup)).toBe(true);
  });

  it('#1336: a plain commit failure leaves the marker on disk → .import-bak + marker preserved (identity-independent)', async () => {
    // A plain commit error must preserve backup when the durable marker remains.
    await writeFile(join(target, 'old.mp3'), Buffer.alloc(300, 1));
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

    const activeBackup = deriveImportSiblings(target).backupPath;
    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(activeBackup)).toBe(true);
  });

  it('false-positive guard: a stale non-empty .import-bak with NO marker is strict-cleared, target NOT regressed', async () => {
    const committedBytes = Buffer.from('NEW-COMMITTED');
    const staleBytes = Buffer.from('OLD-STALE');
    // Without a marker, a leftover backup is disposable success debris.
    await writeFile(join(target, 'book.m4b'), committedBytes);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, 'book.m4b'), staleBytes);

    const log = makeLog();
    await prepareImportSiblings({ targetPath: target, libraryRoot, log });

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

// A non-file marker-path collision must abort before destructive sibling clearing.
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

    expect(await markerPresent(target, makeLog())).toBe(false);
  });

  it('full-flow abort: throws MarkerPathConflictError, leaves an adjacent .import-bak + target audio intact, never stages', async () => {
    const targetBytes = Buffer.from('TARGET-AUDIO');
    const bakBytes = Buffer.from('REAL-BOOK-IN-BAK');
    await writeFile(join(target, 'existing.mp3'), targetBytes);
    await mkdir(`${target}.import-commit-pending`, { recursive: true });
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

    expect(staged).toBe(false);
    expect(await readFile(join(`${target}.import-bak`, 'realbook.mp3'))).toEqual(bakBytes);
    expect(await readFile(join(target, 'existing.mp3'))).toEqual(targetBytes);
    expect(await pathExists(`${target}.import-tmp`)).toBe(false);
  });

  // Linux reports ENOTDIR for this shape; Windows reports ENOENT, so only POSIX reaches
  // the fail-toward-preservation branch through the real filesystem.
  it.skipIf(process.platform === 'win32')('preservation: a genuine non-ENOENT marker stat error still returns true from markerPresent (#1336)', async () => {
    // A file ancestor makes marker stat fail with ENOTDIR.
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
