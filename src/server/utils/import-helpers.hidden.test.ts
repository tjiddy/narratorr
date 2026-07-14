import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  containsAudioFiles,
  countAudioFiles,
  copyAudioFiles,
  copyDiscGroup,
  reconstructDiscGroup,
  getAudioPathSize,
  getVisiblePathSize,
} from './import-helpers.js';

/**
 * #1852 — born-hidden visibility contract, exercised against a REAL tmpdir so the recursive
 * dot-directory skip (files AND subtrees, at every depth) and identity-root policy are proven
 * on the real filesystem rather than a mock. Each classifier must ignore leading-dot files and
 * never descend a `.hidden/` (or `.merge-tmp/`) subtree, while still enumerating the VISIBLE
 * children of a hidden ROOT handed to it by identity.
 */

let root: string;

async function writeBytes(path: string, size: number): Promise<void> {
  await writeFile(path, Buffer.alloc(size, 1));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'narratorr-hidden-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('#1852 recursive dot-directory policy (real fs)', () => {
  it('countAudioFiles skips dot-files and never descends Visible/.hidden/track.mp3', async () => {
    await writeFile(join(root, 'real.mp3'), 'a');
    await writeFile(join(root, '.real.tmp.mp3'), 'a'); // born-hidden temp beside the real file
    await mkdir(join(root, 'Visible'), { recursive: true });
    await writeFile(join(root, 'Visible', 'disc.mp3'), 'a');
    await mkdir(join(root, 'Visible', '.hidden'), { recursive: true });
    await writeFile(join(root, 'Visible', '.hidden', 'track.mp3'), 'a'); // nested hidden subtree

    expect(await countAudioFiles(root)).toBe(2); // real.mp3 + Visible/disc.mp3 only
  });

  it('containsAudioFiles returns false when the only audio lives under a dot-dir', async () => {
    await mkdir(join(root, '.merge-tmp'), { recursive: true });
    await writeFile(join(root, '.merge-tmp', 'track.mp3'), 'a');
    await writeFile(join(root, 'cover.jpg'), 'a');

    expect(await containsAudioFiles(root)).toBe(false);
  });

  it('getAudioPathSize excludes dot-files and dot-dir subtrees at depth', async () => {
    await writeBytes(join(root, 'real.mp3'), 100);
    await writeBytes(join(root, '.temp.tmp.mp3'), 999);
    await mkdir(join(root, '.hidden'), { recursive: true });
    await writeBytes(join(root, '.hidden', 'track.mp3'), 5000);

    expect(await getAudioPathSize(root)).toBe(100);
  });

  it('getAudioPathSize on a direct hidden file is 0 (F32)', async () => {
    await writeBytes(join(root, '.foo.mp3'), 1234);
    expect(await getAudioPathSize(join(root, '.foo.mp3'))).toBe(0);
  });

  it('getVisiblePathSize totals ALL visible files but skips dot-files and dot-dir subtrees', async () => {
    await writeBytes(join(root, 'real.mp3'), 100);
    await writeBytes(join(root, 'cover.jpg'), 50); // visible non-audio still counts (all-files size)
    await writeBytes(join(root, '.temp.tmp.mp3'), 999);
    await mkdir(join(root, '.merge-tmp'), { recursive: true });
    await writeBytes(join(root, '.merge-tmp', 'big.m4b'), 100_000);

    expect(await getVisiblePathSize(root)).toBe(150);
  });

  it('copyAudioFiles (ordinary) flattens only visible audio, skipping dot-files and dot-dirs at depth', async () => {
    await writeFile(join(root, '01.mp3'), 'a');
    await writeFile(join(root, '.01.tmp.mp3'), 'a');
    await mkdir(join(root, 'Extras', '.hidden'), { recursive: true });
    await writeFile(join(root, 'Extras', '.hidden', 'sneaky.mp3'), 'a');
    await writeFile(join(root, 'Extras', 'bonus.mp3'), 'a');

    const dest = join(root, 'out');
    await copyAudioFiles(join(root), dest);
    const copied = (await readdir(dest)).sort();
    expect(copied).toEqual(['01.mp3', 'bonus.mp3']);
  });

  it('copyAudioFiles (multi-disc) skips a nested Disc/.hidden/ subtree', async () => {
    for (const disc of ['CD1', 'CD2']) {
      await mkdir(join(root, 'src', disc), { recursive: true });
      await writeFile(join(root, 'src', disc, 'a.mp3'), 'x');
    }
    await mkdir(join(root, 'src', 'CD1', '.hidden'), { recursive: true });
    await writeFile(join(root, 'src', 'CD1', '.hidden', 'ghost.mp3'), 'x');

    const dest = join(root, 'out');
    await copyAudioFiles(join(root, 'src'), dest);
    // Two discs, one track each → two sequential output files, ghost excluded.
    expect((await readdir(dest)).length).toBe(2);
  });

  it('copyDiscGroup skips a hidden subtree nested under a member disc', async () => {
    const members: string[] = [];
    for (const disc of ['Book Disc 1', 'Book Disc 2']) {
      const p = join(root, disc);
      await mkdir(p, { recursive: true });
      await writeFile(join(p, 't.mp3'), 'x');
      members.push(p);
    }
    await mkdir(join(root, 'Book Disc 1', '.hidden'), { recursive: true });
    await writeFile(join(root, 'Book Disc 1', '.hidden', 'ghost.mp3'), 'x');

    const dest = join(root, 'out');
    await copyDiscGroup(members, dest);
    expect((await readdir(dest)).length).toBe(2);
  });

  it('reconstructDiscGroup never probes a hidden audio-bearing sibling (F42)', async () => {
    await mkdir(join(root, 'Book Disc 1 of 2'), { recursive: true });
    await writeFile(join(root, 'Book Disc 1 of 2', 't.mp3'), 'x');
    await mkdir(join(root, 'Book Disc 2 of 2'), { recursive: true });
    await writeFile(join(root, 'Book Disc 2 of 2', 't.mp3'), 'x');
    // A born-hidden orphan sibling that shares the stem — must be invisible to reconstruction.
    await mkdir(join(root, '.Book Disc 2 of 2'), { recursive: true });
    await writeFile(join(root, '.Book Disc 2 of 2', 't.mp3'), 'x');

    const members = await reconstructDiscGroup(join(root, 'Book Disc 1 of 2'));
    expect(members).toEqual([
      join(root, 'Book Disc 1 of 2'),
      join(root, 'Book Disc 2 of 2'),
    ]);
    expect(members.some((p) => p.includes('/.Book Disc'))).toBe(false);
  });
});

describe('#1852 identity-root policy — hidden ROOT still yields its visible children (F38)', () => {
  it('getAudioPathSize on a hidden dir root sizes its visible audio children', async () => {
    const staging = join(root, '.merge-tmp');
    await mkdir(staging, { recursive: true });
    await writeBytes(join(staging, 'track.mp3'), 42);
    await writeBytes(join(staging, '.half-written.tmp.mp3'), 999);

    expect(await getAudioPathSize(staging)).toBe(42);
  });

  it('getVisiblePathSize on a hidden dir root totals its visible children', async () => {
    const staging = join(root, '.convert-tmp');
    await mkdir(staging, { recursive: true });
    await writeBytes(join(staging, 'a.m4b'), 10);
    await writeBytes(join(staging, 'b.jpg'), 5);

    expect(await getVisiblePathSize(staging)).toBe(15);
  });
});

describe('#1852 getVisiblePathSize does not abort on an unreadable hidden subtree (F40)', () => {
  it('skips a `.hidden/` subtree entirely, so its readability is irrelevant', async () => {
    await writeBytes(join(root, 'real.mp3'), 100);
    const hidden = join(root, '.hidden');
    await mkdir(hidden, { recursive: true });
    await writeBytes(join(hidden, 'big.m4b'), 9999);
    // Even if this subtree were unreadable, the walk never enters it. Best-effort chmod (POSIX).
    await chmod(hidden, 0o000).catch(() => {});

    expect(await getVisiblePathSize(root)).toBe(100);

    await chmod(hidden, 0o755).catch(() => {}); // restore so afterEach cleanup can remove it
  });
});
