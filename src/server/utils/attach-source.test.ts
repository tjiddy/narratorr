import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The node-kind branch needs a stat whose result is neither a file nor a directory. A FIFO covers
// it on Linux (see book-import-files.test.ts) but is unrepresentable on Windows, so the rule is
// pinned everywhere through a stubbed stat here.
const statOverride = { path: null as string | null };
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (p: Parameters<typeof actual.stat>[0], ...rest: never[]) => {
      const stats = await actual.stat(p, ...rest);
      if (statOverride.path !== null && String(p) === statOverride.path) {
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          isFile: () => false,
          isDirectory: () => false,
        });
      }
      return stats;
    },
  };
});

import { admitAttachSource } from './attach-source.js';

describe('admitAttachSource — the node-kind branch (#2435 AC16)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'admit-'));
    statOverride.path = null;
  });

  afterEach(() => {
    statOverride.path = null;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('refuses a node that is neither a regular file nor a directory', async () => {
    const target = join(dir, 'book.m4b');
    writeFileSync(target, Buffer.alloc(16));
    statOverride.path = target;

    const result = await admitAttachSource(target);

    // The blocklist formulation admitted exactly this: `validateSource` falls through both arms
    // and returns success with fileCount 0.
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('neither a regular file nor a directory') });
  });

  it('admits the same path once it stats as a regular file — the positive control', async () => {
    const target = join(dir, 'book.m4b');
    writeFileSync(target, Buffer.alloc(16));

    expect(await admitAttachSource(target)).toEqual({ ok: true });
  });

  it('admits a directory whose audio sits several levels down', async () => {
    const root = join(dir, 'deep');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'track.flac'), Buffer.alloc(16));

    expect(await admitAttachSource(root)).toEqual({ ok: true });
  });

  it('does not count a hidden audio file as making a directory admissible', async () => {
    const root = join(dir, 'hidden-only');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.secret.m4b'), Buffer.alloc(16));

    expect(await admitAttachSource(root)).toEqual({ ok: false, reason: expect.stringContaining('no readable supported audio') });
  });

  it('matches the audio extension case-insensitively', async () => {
    const target = join(dir, 'Book.M4B');
    writeFileSync(target, Buffer.alloc(16));

    expect(await admitAttachSource(target)).toEqual({ ok: true });
  });

  // #2495 AC9 boundary. This surface admits by node kind, hiddenness, extension and readability —
  // deliberately NOT by stream content, so an operator can attach a file the automatic gate would
  // hold. The contract is pinned here so adding stream probing (which would change admission for
  // all ten registry members) has to be a deliberate contract change, not a drive-by.
  it('admits a readable .mp4 whose bytes carry no audio stream at all', async () => {
    const target = join(dir, 'NoAudioStream.mp4');
    writeFileSync(target, Buffer.from('not really an mp4 at all'));

    expect(await admitAttachSource(target)).toEqual({ ok: true });
  });

  it('admits a directory holding only a bare .mp4', async () => {
    const root = join(dir, 'abb-download');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'FortuneFunhouseMissFortuneMysteriesBook19.mp4'), Buffer.alloc(16));

    expect(await admitAttachSource(root)).toEqual({ ok: true });
  });

  it('still refuses a hidden .mp4', async () => {
    const target = join(dir, '.Book.mp4');
    writeFileSync(target, Buffer.alloc(16));

    expect(await admitAttachSource(target)).toEqual({ ok: false, reason: expect.stringContaining('hidden') });
  });

  it('still refuses a near-miss .mp4v', async () => {
    const target = join(dir, 'Book.mp4v');
    writeFileSync(target, Buffer.alloc(16));

    expect(await admitAttachSource(target)).toEqual({ ok: false, reason: expect.stringContaining('not a supported audio format') });
  });
});
