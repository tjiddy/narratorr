import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lstat, readdir, rmdir } from 'node:fs/promises';
import { classifyTargetOccupancy, clearVerifiedEmptyTarget } from './rename-target-guard.js';
import { RenameError } from './rename-error.js';

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

// Partial mock so real link/directory semantics run while specific errnos stay injectable.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  lstat: vi.fn(),
  readdir: vi.fn(),
  rmdir: vi.fn(),
}));

const CAN_SYMLINK = await (async () => {
  const probe = await actualFs.mkdtemp(join(tmpdir(), 'symlink-probe-'));
  try {
    const target = join(probe, 't');
    await actualFs.writeFile(target, '');
    await actualFs.symlink(target, join(probe, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    await actualFs.rm(probe, { recursive: true, force: true });
  }
})();

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('classifyTargetOccupancy', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    (lstat as Mock).mockImplementation(actualFs.lstat as never);
    (readdir as Mock).mockImplementation(actualFs.readdir as never);
    (rmdir as Mock).mockImplementation(actualFs.rmdir as never);
    dir = await actualFs.mkdtemp(join(tmpdir(), 'rename-target-guard-'));
  });

  afterEach(async () => {
    try {
      await actualFs.rm(dir, { recursive: true, force: true });
    } catch {
      // Tolerant teardown; a leaked tmpdir is cheaper than a red suite.
    }
  });

  it('reports absent for a path that does not exist', async () => {
    await expect(classifyTargetOccupancy(join(dir, 'nothing'))).resolves.toBe('absent');
  });

  it('reports empty-directory for an existing empty directory', async () => {
    const target = join(dir, 'empty');
    await actualFs.mkdir(target);
    await expect(classifyTargetOccupancy(target)).resolves.toBe('empty-directory');
  });

  it('refuses a directory holding one entry, naming the path', async () => {
    const target = join(dir, 'populated');
    await actualFs.mkdir(target);
    await actualFs.writeFile(join(target, 'a.m4b'), 'x');

    const error = await classifyTargetOccupancy(target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenameError);
    expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
    expect((error as RenameError).message).toContain(target.split('\\').join('/'));
  });

  it('refuses a regular file at the target without letting ENOTDIR escape', async () => {
    const target = join(dir, 'a-file');
    await actualFs.writeFile(target, 'x');

    const error = await classifyTargetOccupancy(target).catch((e: unknown) => e);
    expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
    expect((error as Error).message).not.toContain('ENOTDIR');
    // readdir is reached only on the directory arm, so ENOTDIR can never be raised.
    expect(readdir as Mock).not.toHaveBeenCalled();
  });

  it.skipIf(!CAN_SYMLINK)('refuses a symlink pointing at an empty directory, leaving link and target intact', async () => {
    const linkTarget = join(dir, 'elsewhere');
    await actualFs.mkdir(linkTarget);
    const target = join(dir, 'link');
    await actualFs.symlink(linkTarget, target);

    const error = await classifyTargetOccupancy(target).catch((e: unknown) => e);
    expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
    expect((await actualFs.lstat(target)).isSymbolicLink()).toBe(true);
    expect((await actualFs.lstat(linkTarget)).isDirectory()).toBe(true);
  });

  it.skipIf(!CAN_SYMLINK)('refuses a broken symlink, which stat would report as ENOENT and wrongly absorb', async () => {
    const target = join(dir, 'broken');
    await actualFs.symlink(join(dir, 'does-not-exist'), target);

    const error = await classifyTargetOccupancy(target).catch((e: unknown) => e);
    expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
  });

  it('refuses when lstat fails for a non-ENOENT reason', async () => {
    (lstat as Mock).mockRejectedValueOnce(errno('EACCES'));

    const error = await classifyTargetOccupancy(join(dir, 'whatever')).catch((e: unknown) => e);
    expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
  });

  it('refuses when readdir fails on a real directory', async () => {
    const target = join(dir, 'unreadable');
    await actualFs.mkdir(target);
    (readdir as Mock).mockRejectedValueOnce(errno('EACCES'));

    const error = await classifyTargetOccupancy(target).catch((e: unknown) => e);
    expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
  });
});

describe('clearVerifiedEmptyTarget', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    (lstat as Mock).mockImplementation(actualFs.lstat as never);
    (readdir as Mock).mockImplementation(actualFs.readdir as never);
    (rmdir as Mock).mockImplementation(actualFs.rmdir as never);
    dir = await actualFs.mkdtemp(join(tmpdir(), 'rename-target-clear-'));
  });

  afterEach(async () => {
    try {
      await actualFs.rm(dir, { recursive: true, force: true });
    } catch {
      // Tolerant teardown; see windows-hostile-test-primitives.
    }
  });

  it('removes the empty directory so the move never depends on rename(2) replacing it', async () => {
    const target = join(dir, 'empty');
    await actualFs.mkdir(target);

    await clearVerifiedEmptyTarget(target);

    await expect(actualFs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['ENOTEMPTY', 'EEXIST', 'EACCES'])('refuses with TARGET_OCCUPIED when rmdir fails with %s', async (code) => {
    (rmdir as Mock).mockRejectedValueOnce(errno(code));

    const error = await clearVerifiedEmptyTarget(join(dir, 'empty')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenameError);
    expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
  });
});
