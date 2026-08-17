import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '@db/index.js';
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

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/** The temp path the writer actually chose — asserting cleanup targets it pins the boundary. */
function tempPathWritten(): string {
  return (writeFile as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
}

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
    expect(outcome).toBe('written');
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
    expect(unlink).toHaveBeenCalledWith(tempPathWritten());
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('THROWS and cleans up the temp file when the temp WRITE fails (#2302)', async () => {
    (writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(errno('ENOSPC'));
    const mockDb = createMockDb();
    await expect(
      uploadBookCover(5, '/books/b', PNG, 'image/png', inject<Db>(mockDb), log),
    ).rejects.toThrow('ENOSPC');
    expect(unlink).toHaveBeenCalledWith(tempPathWritten());
    expect(rename).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('propagates the ORIGINAL write error when the cleanup unlink itself rejects (#2302)', async () => {
    const cause = errno('ENOSPC');
    (writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(cause);
    (unlink as ReturnType<typeof vi.fn>).mockRejectedValue(errno('EACCES'));
    await expect(
      uploadBookCover(5, '/books/b', PNG, 'image/png', inject<Db>(createMockDb()), log),
    ).rejects.toBe(cause);
  });

  it('never unlinks the temp on the success path (#2302)', async () => {
    await uploadBookCover(5, '/books/b', PNG, 'image/png', inject<Db>(createMockDb()), log);
    expect(unlink).not.toHaveBeenCalled();
  });
});
