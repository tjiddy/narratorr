import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject, createMockDb, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { confirmImport, type ImportPipelineDeps } from './import-orchestration.helpers.js';

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn().mockResolvedValue({ enriched: true }),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/import-helpers.js', () => ({
  buildTargetPath: vi.fn().mockReturnValue('/library/Author/Title'),
  getPathSize: vi.fn().mockResolvedValue(1000),
  getAudioPathSize: vi.fn().mockResolvedValue(1000),
}));

import { enrichBookFromAudio } from './enrichment-utils.js';

function createMockLogger(): FastifyBaseLogger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('confirmImport — SSE emissions (#618)', () => {
  let deps: ImportPipelineDeps;
  let mockBookService: { findDuplicate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let mockBroadcaster: { emit: ReturnType<typeof vi.fn> };
  let mockEventHistory: { create: ReturnType<typeof vi.fn> };
  let mockDb: ReturnType<typeof createMockDb> & ReturnType<typeof mockDbChain>;

  beforeEach(() => {
    const db = createMockDb();
    const chain = mockDbChain();
    db.select.mockReturnValue(chain as never);
    db.update.mockReturnValue(chain as never);
    mockDb = Object.assign(db, chain);

    mockBookService = {
      findDuplicate: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (data: { title: string }) => ({
        id: 1, title: data.title, status: 'importing',
      })),
      update: vi.fn().mockResolvedValue({ id: 1 }),
    };
    mockBroadcaster = { emit: vi.fn() };
    mockEventHistory = { create: vi.fn().mockResolvedValue({}) };

    const log = createMockLogger();
    const mockSettingsService = createMockSettingsService({ library: { path: '/library' } });

    deps = {
      db: inject<Db>(mockDb),
      log,
      bookService: inject<BookService>(mockBookService),
      settingsService: inject<SettingsService>(mockSettingsService),
      eventHistory: inject<EventHistoryService>(mockEventHistory),
      enrichmentDeps: {
        db: inject<Db>(mockDb),
        log,
        settingsService: inject<SettingsService>(mockSettingsService),
        bookService: inject<BookService>(mockBookService),
        metadataService: { searchBooks: vi.fn().mockResolvedValue([]), getBook: vi.fn().mockResolvedValue(null), enrichBook: vi.fn().mockResolvedValue(null) } as never,
      } satisfies EnrichmentDeps,
      broadcaster: mockBroadcaster as unknown as EventBroadcasterService,
    };
  });

  it('emits book_status_change importing→imported after background success', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 42, title: 'Test', status: 'importing' });

    await confirmImport(
      [{ path: '/audiobooks/Author/Title', title: 'Test', authorName: 'Author' }],
      deps,
    );

    await vi.waitFor(() => {
      expect(mockBroadcaster.emit).toHaveBeenCalledWith('book_status_change', {
        book_id: 42, old_status: 'importing', new_status: 'imported',
      });
    });
  });

  it('emits book_status_change importing→missing after background failure', async () => {
    mockBookService.create.mockResolvedValueOnce({ id: 7, title: 'Broken', status: 'importing' });
    vi.mocked(enrichBookFromAudio).mockRejectedValueOnce(new Error('Enrichment failed'));

    await confirmImport(
      [{ path: '/bad', title: 'Broken' }],
      deps,
    );

    await vi.waitFor(() => {
      expect(mockBroadcaster.emit).toHaveBeenCalledWith('book_status_change', {
        book_id: 7, old_status: 'importing', new_status: 'missing',
      });
    });
  });

  it('does not emit when broadcaster is undefined', async () => {
    const noBroadcasterDeps = { ...deps, broadcaster: undefined };
    mockBookService.create.mockResolvedValueOnce({ id: 5, title: 'Silent', status: 'importing' });

    await confirmImport(
      [{ path: '/a/b', title: 'Silent' }],
      noBroadcasterDeps,
    );

    await new Promise(r => setTimeout(r, 50));
    expect(mockBroadcaster.emit).not.toHaveBeenCalled();
  });

  it('does not emit for duplicate-skipped items', async () => {
    mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Dup' });

    await confirmImport(
      [{ path: '/a/b', title: 'Dup', authorName: 'Author' }],
      deps,
    );

    await new Promise(r => setTimeout(r, 50));
    expect(mockBroadcaster.emit).not.toHaveBeenCalled();
  });
});
