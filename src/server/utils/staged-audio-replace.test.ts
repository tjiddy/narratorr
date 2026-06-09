import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { stagedAudioReplace } from './import-steps.js';
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
});
