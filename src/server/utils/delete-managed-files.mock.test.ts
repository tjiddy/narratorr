import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs failures that real tmpdirs cannot reliably produce under a privileged runner.
vi.mock('node:fs/promises', () => ({
  // Default top-level lstat to a non-symlink directory.
  lstat: vi.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
  readdir: vi.fn().mockResolvedValue([]),
  // Default OPF content to unmarked and foreign.
  readFile: vi.fn().mockResolvedValue('<?xml version="1.0"?><package><metadata><dc:title>foreign</dc:title></metadata></package>'),
  rm: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
  // Identity realpath keeps ordinary fixtures contained.
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
    vi.mocked(rmdir).mockRejectedValue(Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }));

    const result = await deleteManagedBookFiles('/lib/Book', '/lib', log);

    expect(base(result.failedManaged)).toEqual(['locked.mp3']);
    expect(base(result.deletedManaged)).toEqual(['free.mp3']);
    expect(result.preservedForeign).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
    expect(rmdir).toHaveBeenCalledWith('/lib/Book');
  });
});
