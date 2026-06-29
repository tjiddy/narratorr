import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
}));

import { writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { uploadBookCover, CoverUploadError } from './cover-upload.js';

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info',
  });
}

function createMockDb(whereImpl: () => Promise<unknown> = () => Promise.resolve(undefined)) {
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(whereImpl) }),
    }),
  };
}

const PNG = Buffer.from('fake-png');

describe('uploadBookCover (#1707 CoverWriteOutcome)', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (rename as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (unlink as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    log = createMockLogger();
  });

  it("returns 'written' on a successful temp→rename and updates the DB coverUrl", async () => {
    const mockDb = createMockDb();
    const outcome = await uploadBookCover(5, '/books/b', PNG, 'image/png', inject<Db>(mockDb), log);
    expect(outcome).toBe('written');
    expect(rename).toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("returns 'written' even when the post-rename DB coverUrl update throws (file materialized)", async () => {
    const mockDb = createMockDb(() => Promise.reject(new Error('DB locked')));
    const outcome = await uploadBookCover(5, '/books/b', PNG, 'image/png', inject<Db>(mockDb), log);
    expect(outcome).toBe('written'); // the cover file committed; a stale coverUrl self-heals
    expect(rename).toHaveBeenCalled();
  });

  it('THROWS CoverUploadError on an unsupported MIME (pre-rename failure — no spurious success)', async () => {
    const mockDb = createMockDb();
    await expect(
      uploadBookCover(5, '/books/b', PNG, 'application/pdf', inject<Db>(mockDb), log),
    ).rejects.toBeInstanceOf(CoverUploadError);
    expect(rename).not.toHaveBeenCalled();
  });

  it('THROWS and cleans up the temp file when the rename fails (pre-rename failure)', async () => {
    (rename as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES'));
    const mockDb = createMockDb();
    await expect(
      uploadBookCover(5, '/books/b', PNG, 'image/png', inject<Db>(mockDb), log),
    ).rejects.toThrow('EACCES');
    expect(unlink).toHaveBeenCalled(); // temp cleaned
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
