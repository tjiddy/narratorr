import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../services/book.service.js';
import type { SettingsService } from '../services/settings.service.js';

vi.mock('./opf-writer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./opf-writer.js')>()),
  writeOpfSidecar: vi.fn().mockResolvedValue('written'),
}));

import { refreshOpfForBook } from './opf-refresh.js';
import { writeOpfSidecar } from './opf-writer.js';

const writeOpfMock = vi.mocked(writeOpfSidecar);

function makeLog(): FastifyBaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), silent: vi.fn(), level: 'info' } as unknown as FastifyBaseLogger;
}

const settingsService = inject<SettingsService>({ get: vi.fn().mockResolvedValue({ writeOpf: true }) });
const bookService = inject<BookService>({ getById: vi.fn() });

function run(bookFolder: string | null) {
  return refreshOpfForBook({ settingsService, bookService, bookId: 1, bookFolder, log: makeLog() });
}

describe('refreshOpfForBook (#1707 — returns the OpfWriteOutcome)', () => {
  beforeEach(() => { vi.clearAllMocks(); writeOpfMock.mockResolvedValue('written'); });

  it("returns 'written' and calls writeOpfSidecar (not the void wrapper) with the writeOpf gate", async () => {
    const outcome = await run('/lib/Author/Book');
    expect(outcome).toBe('written');
    expect(writeOpfMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, bookId: 1, bookFolder: '/lib/Author/Book' }));
  });

  it("propagates 'skipped' from the writer (writeOpf off / foreign OPF)", async () => {
    writeOpfMock.mockResolvedValue('skipped');
    expect(await run('/lib/Author/Book')).toBe('skipped');
  });

  it("returns 'skipped' for a not-imported book (null folder) without calling the writer", async () => {
    expect(await run(null)).toBe('skipped');
    expect(writeOpfMock).not.toHaveBeenCalled();
  });

  it("returns 'failed' (swallowed, logged) when the writer throws", async () => {
    writeOpfMock.mockRejectedValue(new Error('boom'));
    expect(await run('/lib/Author/Book')).toBe('failed');
  });
});
