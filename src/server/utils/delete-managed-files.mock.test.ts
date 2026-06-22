import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked-fs error-injection suite (per the #1589 test plan: real tmpdir for FS-truth lives in
// delete-managed-files.test.ts; this file injects rm failures the real fs can't reliably produce
// when the test runner is root). Defaults: a directory stat, a flat readdir, rm/rmdir resolve.
vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false }),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  // #1591: guarded mode now runs the symlink-aware realpath containment. Identity realpath (no
  // symlinks) keeps the lexical-equivalent containment for the in-library paths these tests use.
  realpath: vi.fn().mockImplementation(async (p: unknown) => String(p)),
}));

import { readdir, rm, rmdir } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { deleteManagedBookFiles } from './delete-managed-files.js';

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

const dirent = (name: string) => ({ name, isFile: () => true, isDirectory: () => false });
const base = (paths: string[]): string[] => paths.map((p) => p.split(/[\\/]/).pop()!).sort();

describe('deleteManagedBookFiles — error injection', () => {
  beforeEach(() => {
    vi.mocked(readdir).mockReset();
    vi.mocked(rm).mockReset();
    vi.mocked(rmdir).mockReset();
    vi.mocked(rmdir).mockResolvedValue(undefined);
  });

  it('records a managed rm failure (EPERM) without throwing and does not remove the folder', async () => {
    const log = makeLog();
    vi.mocked(readdir).mockResolvedValue([dirent('locked.mp3'), dirent('free.mp3')] as never);
    vi.mocked(rm).mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('locked.mp3')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    // Folder is non-empty because a managed file remains → rmdir refuses.
    vi.mocked(rmdir).mockRejectedValue(Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }));

    const result = await deleteManagedBookFiles('/lib/Book', '/lib', log);

    expect(base(result.failedManaged)).toEqual(['locked.mp3']);
    expect(base(result.deletedManaged)).toEqual(['free.mp3']);
    expect(result.preservedForeign).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
    // Folder-retention consequence (#1591): rmdir is attempted but the surviving failed-managed file
    // makes it ENOTEMPTY, which is swallowed — the folder is NOT removed and the helper never throws.
    expect(rmdir).toHaveBeenCalledWith('/lib/Book');
  });
});
