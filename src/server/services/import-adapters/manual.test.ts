import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject, createMockSettingsService } from '../../__tests__/helpers.js';
import type { Db } from '../../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../book.service.js';
import type { SettingsService } from '../settings.service.js';
import type { EventHistoryService } from '../event-history.service.js';
import type { EventBroadcasterService } from '../event-broadcaster.service.js';
import type { EnrichmentDeps } from '../enrichment-orchestration.helpers.js';
import type { ImportPipelineDeps } from '../import-orchestration.helpers.js';
import type { ImportAdapterContext, ImportJob, ManualImportJobPayload } from './types.js';
import { ManualImportAdapter } from './manual.js';

vi.mock('../enrichment-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('../enrichment-orchestration.helpers.js')),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: true }),
}));

vi.mock('../library-scan.helpers.js', () => ({
  getAudioStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSize: 100_000 }),
}));

vi.mock('../import-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('../import-orchestration.helpers.js')),
  copyToLibrary: vi.fn().mockResolvedValue('/library/Author/Title'),
}));

vi.mock('../../utils/safe-emit.js', () => ({
  safeEmit: vi.fn(),
}));

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function createMockDb() {
  const setMock = vi.fn().mockReturnThis();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ id: 1, title: 'Test Book', genres: ['Fantasy'] }]),
    set: setMock,
  };
  return {
    select: vi.fn().mockReturnValue(chain),
    update: vi.fn().mockReturnValue({ ...chain, where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
    insert: vi.fn().mockReturnValue(chain),
    transaction: vi.fn(),
  };
}

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  const payload: ManualImportJobPayload = {
    path: '/audiobooks/Author/Title',
    title: 'Test Book',
    authorName: 'Author',
    mode: 'copy',
  };
  return {
    id: 1,
    bookId: 42,
    type: 'manual',
    status: 'processing',
    phase: 'queued',
    metadata: JSON.stringify(payload),
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
    phaseHistory: null,
    completedAt: null,
    ...overrides,
  };
}

describe('ManualImportAdapter', () => {
  let adapter: ManualImportAdapter;
  let deps: ImportPipelineDeps;
  let ctx: ImportAdapterContext;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventHistory: { create: ReturnType<typeof vi.fn> };
  let mockBroadcaster: { emit: ReturnType<typeof vi.fn> };
  let setPhase: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb = createMockDb();
    mockEventHistory = { create: vi.fn().mockResolvedValue({}) };
    mockBroadcaster = { emit: vi.fn() };
    const log = createMockLogger();
    const mockSettingsService = createMockSettingsService({ library: { path: '/library' } });

    deps = {
      db: inject<Db>(mockDb),
      log,
      bookService: inject<BookService>({ findDuplicate: vi.fn(), create: vi.fn() }),
      settingsService: inject<SettingsService>(mockSettingsService),
      eventHistory: inject<EventHistoryService>(mockEventHistory),
      enrichmentDeps: {
        db: inject<Db>(mockDb),
        log,
        settingsService: inject<SettingsService>(mockSettingsService),
        bookService: inject<BookService>({ findDuplicate: vi.fn(), create: vi.fn() }),
        metadataService: { searchBooks: vi.fn(), getBook: vi.fn(), enrichBook: vi.fn() } as never,
      } satisfies EnrichmentDeps,
      broadcaster: mockBroadcaster as unknown as EventBroadcasterService,
    };

    setPhase = vi.fn().mockResolvedValue(undefined);
    ctx = {
      db: inject<Db>(mockDb),
      log,
      setPhase: setPhase as unknown as ImportAdapterContext['setPhase'],
      emitProgress: vi.fn(),
    };

    adapter = new ManualImportAdapter(deps);
  });

  describe('process', () => {
    it('happy path: processes book — updates status to imported and records event', async () => {
      const job = makeJob();
      await adapter.process(job, ctx);

      // setPhase called with analyzing, copying, fetching_metadata
      const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
      expect(phases).toContain('analyzing');
      expect(phases).toContain('copying');
      expect(phases).toContain('fetching_metadata');

      // Event history recorded
      expect(mockEventHistory.create).toHaveBeenCalled();
    });

    it('pointer mode: metadata mode is undefined — skips copy phase', async () => {
      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
        // mode omitted = pointer
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });

      await adapter.process(job, ctx);

      const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
      expect(phases).toContain('analyzing');
      expect(phases).not.toContain('copying');
      expect(phases).toContain('fetching_metadata');
    });

    it('throws when bookId is null', async () => {
      const job = makeJob({ bookId: null });

      await expect(adapter.process(job, ctx)).rejects.toThrow('ManualImportAdapter requires a bookId');
    });

    it('throws when book row not found (deleted after queuing)', async () => {
      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });
      ctx.db = inject<Db>(mockDb);

      const job = makeJob();
      await expect(adapter.process(job, ctx)).rejects.toThrow('Book 42 not found');
    });

    it('hydrates ManualImportJobPayload from job.metadata JSON including mode', async () => {
      const { copyToLibrary } = await import('../import-orchestration.helpers.js');
      const job = makeJob();
      await adapter.process(job, ctx);

      // copyToLibrary should have been called (mode='copy')
      expect(vi.mocked(copyToLibrary)).toHaveBeenCalled();
    });

    it('emits book_status_change SSE and records import_failed event on failure (#636 F2)', async () => {
      const { safeEmit } = await import('../../utils/safe-emit.js');
      const { copyToLibrary } = await import('../import-orchestration.helpers.js');
      vi.mocked(copyToLibrary).mockRejectedValueOnce(new Error('Disk full'));

      const job = makeJob();
      await expect(adapter.process(job, ctx)).rejects.toThrow('Disk full');

      // Failure SSE emitted
      expect(vi.mocked(safeEmit)).toHaveBeenCalledWith(
        mockBroadcaster,
        'book_status_change',
        expect.objectContaining({ book_id: 42, old_status: 'importing', new_status: 'failed' }),
        expect.anything(),
      );

      // Failure event recorded with error payload for UI display
      expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'import_failed',
        bookId: 42,
        source: 'manual',
        reason: { error: 'Disk full' },
      }));
    });
  });
});
