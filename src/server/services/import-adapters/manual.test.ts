import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dirent } from 'node:fs';
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

// Boundary choice: this file mocks fs primitives + streamCopyWithProgress + getAudioPathSize,
// NOT copyToLibrary / renameFilesWithTemplate. Real copyToLibrary and renameFilesWithTemplate
// run against these lower mocks, so a regression at the adapter↔helper seam (wrong source/target
// path, missing callback, broken rollback) surfaces here. streamCopyWithProgress is mocked rather
// than the underlying stream primitives because its dedicated test exercises real streams.

vi.mock('../enrichment-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('../enrichment-orchestration.helpers.js')),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: true }),
}));

vi.mock('../library-scan.helpers.js', () => ({
  getAudioStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSize: 100_000 }),
}));

vi.mock('../streaming-copy.helpers.js', () => ({
  streamCopyWithProgress: vi.fn(),
}));

vi.mock('../../utils/import-helpers.js', async () => ({
  ...(await vi.importActual('../../utils/import-helpers.js')),
  getAudioPathSize: vi.fn(),
}));

vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual('node:fs/promises')),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  readdir: vi.fn(),
  cp: vi.fn(),
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

function makeDirent(name: string, isFile: boolean): Dirent {
  return { name, isFile: () => isFile, isDirectory: () => !isFile } as Dirent;
}

// path.join produces backslashes on Windows; normalize captured rename args to POSIX before
// comparing against forward-slash literals so these assertions work on both platforms.
const normPath = (p: unknown): string => String(p).split('\\').join('/');

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

// Default settings (path:'/library', folderFormat:'{author}/{title}') + payload (title:'Test Book',
// authorName:'Author') yield this target path via buildTargetPath.
const TARGET_PATH = '/library/Author/Test Book';

describe('ManualImportAdapter', () => {
  let adapter: ManualImportAdapter;
  let deps: ImportPipelineDeps;
  let ctx: ImportAdapterContext;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventHistory: { create: ReturnType<typeof vi.fn> };
  let mockBroadcaster: { emit: ReturnType<typeof vi.fn> };
  let setPhase: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fs = await import('node:fs/promises');
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([] as never);
    vi.mocked(fs.cp).mockResolvedValue(undefined);

    const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');
    vi.mocked(streamCopyWithProgress).mockResolvedValue(undefined);

    const { getAudioPathSize } = await import('../../utils/import-helpers.js');
    // Source/target return equal sizes so target/source >= 0.99 verification passes.
    vi.mocked(getAudioPathSize).mockResolvedValue(100);

    mockDb = createMockDb();
    mockEventHistory = { create: vi.fn().mockResolvedValue({}) };
    mockBroadcaster = { emit: vi.fn() };
    const log = createMockLogger();
    const mockSettingsService = createMockSettingsService({ library: { path: '/library', fileFormat: '' } });

    deps = {
      db: inject<Db>(mockDb),
      log,
      bookService: inject<BookService>({ findDuplicate: vi.fn(), create: vi.fn(), getById: vi.fn().mockResolvedValue(null) }),
      settingsService: inject<SettingsService>(mockSettingsService),
      eventHistory: inject<EventHistoryService>(mockEventHistory),
      enrichmentDeps: {
        db: inject<Db>(mockDb),
        log,
        settingsService: inject<SettingsService>(mockSettingsService),
        bookService: inject<BookService>({ findDuplicate: vi.fn(), create: vi.fn(), getById: vi.fn().mockResolvedValue(null) }),
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

      const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
      expect(phases).toContain('analyzing');
      expect(phases).toContain('copying');
      expect(phases).toContain('fetching_metadata');

      expect(mockEventHistory.create).toHaveBeenCalled();
    });

    it('mode=copy: calls fs.mkdir(target, { recursive: true }) before streamCopyWithProgress', async () => {
      const fs = await import('node:fs/promises');
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');

      const callOrder: string[] = [];
      vi.mocked(fs.mkdir).mockImplementationOnce(async (...args: unknown[]) => {
        callOrder.push(`mkdir:${String(args[0])}`);
        return undefined as never;
      });
      vi.mocked(streamCopyWithProgress).mockImplementationOnce(async () => {
        callOrder.push('streamCopy');
      });

      const job = makeJob();
      await adapter.process(job, ctx);

      expect(vi.mocked(fs.mkdir)).toHaveBeenCalledWith(TARGET_PATH, { recursive: true });
      expect(callOrder).toEqual([`mkdir:${TARGET_PATH}`, 'streamCopy']);
    });

    it('mode=copy: invokes streamCopyWithProgress with (payload.path, target, callback)', async () => {
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');

      const job = makeJob();
      await adapter.process(job, ctx);

      expect(vi.mocked(streamCopyWithProgress)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(streamCopyWithProgress)).toHaveBeenCalledWith(
        '/audiobooks/Author/Title',
        TARGET_PATH,
        expect.any(Function),
      );
    });

    it('mode=move: calls fs.rm on source after copy verification', async () => {
      const fs = await import('node:fs/promises');

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author', mode: 'move',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });
      await adapter.process(job, ctx);

      expect(vi.mocked(fs.rm)).toHaveBeenCalledWith('/audiobooks/Author/Title', { recursive: true });
    });

    it('pointer mode: metadata mode is undefined — skips copy phase and streamCopyWithProgress', async () => {
      const fs = await import('node:fs/promises');
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');

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
      expect(vi.mocked(streamCopyWithProgress)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalledWith(TARGET_PATH, expect.anything());
    });

    it('throws when bookId is null (before any fs primitive or streamCopyWithProgress call)', async () => {
      const fs = await import('node:fs/promises');
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');

      const job = makeJob({ bookId: null });

      await expect(adapter.process(job, ctx)).rejects.toThrow('ManualImportAdapter requires a bookId');
      expect(vi.mocked(streamCopyWithProgress)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
    });

    it('throws when book row not found — before any fs primitive or streamCopyWithProgress call', async () => {
      const fs = await import('node:fs/promises');
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');

      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });
      ctx.db = inject<Db>(mockDb);

      const job = makeJob();
      await expect(adapter.process(job, ctx)).rejects.toThrow('Book 42 not found');
      expect(vi.mocked(streamCopyWithProgress)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
    });

    it('hydrates ManualImportJobPayload from job.metadata JSON including mode', async () => {
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');
      const job = makeJob();
      await adapter.process(job, ctx);

      // mode='copy' → streamCopyWithProgress should run
      expect(vi.mocked(streamCopyWithProgress)).toHaveBeenCalled();
    });

    it('onProgress wiring during copy: forwards captured callback values to ctx.emitProgress', async () => {
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');

      vi.mocked(streamCopyWithProgress).mockImplementationOnce(async (_src, _dest, onProgress) => {
        onProgress(0.25, { current: 25, total: 100 });
        onProgress(0.5, { current: 50, total: 100 });
        onProgress(1.0, { current: 100, total: 100 });
      });

      const job = makeJob();
      await adapter.process(job, ctx);

      const copyingCalls = (ctx.emitProgress as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: unknown[]) => c[0] === 'copying');
      expect(copyingCalls).toEqual([
        ['copying', 0.25, { current: 25, total: 100 }],
        ['copying', 0.5, { current: 50, total: 100 }],
        ['copying', 1.0, { current: 100, total: 100 }],
      ]);
    });

    describe('renaming phase (#650)', () => {
      function makeRenameSettingsService(fileFormat: string) {
        return createMockSettingsService({ library: { path: '/library', fileFormat } });
      }

      function makeBookServiceWithNarrators(narrators: Array<{ id: number; name: string; asin: string | null }>) {
        return inject<BookService>({
          findDuplicate: vi.fn(), create: vi.fn(),
          getById: vi.fn().mockResolvedValue({
            id: 1, title: 'Test Book', seriesName: 'Test Series', seriesPosition: 1,
            narrators, authors: [{ id: 1, name: 'Author', asin: null }],
            publishedDate: '2024-01-15', path: '/library/Author/Title',
            status: 'importing', size: 100_000, genres: ['Fantasy'],
          }),
        });
      }

      async function mockReaddirAudioFiles(names: string[]) {
        const fs = await import('node:fs/promises');
        vi.mocked(fs.readdir).mockResolvedValue(names.map(n => makeDirent(n, true)) as never);
      }

      it('mode=copy + fileFormat set: calls setPhase in order [analyzing, copying, renaming, fetching_metadata]', async () => {
        await mockReaddirAudioFiles(['a.mp3']);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
        expect(phases).toEqual(['analyzing', 'copying', 'renaming', 'fetching_metadata']);
      });

      it('mode=copy + fileFormat set: adapter snapshots settingsService.get(library) once for rename (copyToLibrary fetches its own)', async () => {
        await mockReaddirAudioFiles(['a.mp3']);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        // Adapter takes one snapshot it passes to renameIfConfigured; real copyToLibrary
        // fetches independently. Total of 2 — a regression that adds a second adapter
        // fetch for rename would push this to 3.
        const libraryCalls = (settingsSvc.get as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'library');
        expect(libraryCalls).toHaveLength(2);
      });

      it('mode=copy + fileFormat=\'{title}\' + 3 audio files: fs.rename called 3 times with (target/oldName, target/newName)', async () => {
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3', 'b.mp3', 'c.mp3']);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        // 3 forward renames; collisions on '{title}' → 'Test Book', 'Test Book (2)', 'Test Book (3)'.
        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(3);
        const calls = vi.mocked(fs.rename).mock.calls;
        expect(calls[0].map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book.mp3`]);
        expect(calls[1].map(normPath)).toEqual(
          [`${TARGET_PATH}/b.mp3`, `${TARGET_PATH}/Test Book (2).mp3`]);
        expect(calls[2].map(normPath)).toEqual(
          [`${TARGET_PATH}/c.mp3`, `${TARGET_PATH}/Test Book (3).mp3`]);
      });

      it('onProgress wiring: 3 renames emit proportional renaming progress through real helper', async () => {
        await mockReaddirAudioFiles(['a.mp3', 'b.mp3', 'c.mp3']);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        const renamingCalls = (ctx.emitProgress as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'renaming');
        expect(renamingCalls).toHaveLength(3);
        expect(renamingCalls[0]).toEqual(['renaming', 1 / 3, { current: 1, total: 3 }]);
        expect(renamingCalls[1]).toEqual(['renaming', 2 / 3, { current: 2, total: 3 }]);
        expect(renamingCalls[2]).toEqual(['renaming', 1, { current: 3, total: 3 }]);
      });

      it('onProgress wiring: single-rename edge case emits exactly one (1, 1) renaming progress event', async () => {
        await mockReaddirAudioFiles(['original.mp3']);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        const renamingCalls = (ctx.emitProgress as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'renaming');
        expect(renamingCalls).toHaveLength(1);
        expect(renamingCalls[0]).toEqual(['renaming', 1, { current: 1, total: 1 }]);
      });

      it('zero audio files in target dir: no fs.rename calls, no renaming progress events', async () => {
        const fs = await import('node:fs/promises');
        // Non-audio entries only — paths.ts:72 short-circuit returns 0.
        await mockReaddirAudioFiles([]);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
        const renamingCalls = (ctx.emitProgress as ReturnType<typeof vi.fn>).mock.calls
          .filter((c: unknown[]) => c[0] === 'renaming');
        expect(renamingCalls).toHaveLength(0);
      });

      it('mode=move + fileFormat set: includes renaming in setPhase sequence', async () => {
        await mockReaddirAudioFiles(['a.mp3']);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const payload: ManualImportJobPayload = { path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author', mode: 'move' };
        const job = makeJob({ metadata: JSON.stringify(payload) });
        await adapter.process(job, ctx);

        const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
        expect(phases).toContain('renaming');
      });

      it('mode=copy + fileFormat empty (defensive): does NOT call setPhase(renaming) or fs.rename', async () => {
        const fs = await import('node:fs/promises');
        // fileFormat already '' in default beforeEach setup
        const job = makeJob();
        await adapter.process(job, ctx);

        const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
        expect(phases).not.toContain('renaming');
        expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
      });

      it('mode=copy + fileFormat whitespace only (defensive): does NOT call setPhase(renaming) or fs.rename', async () => {
        const fs = await import('node:fs/promises');
        const settingsSvc = makeRenameSettingsService('   ');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
        expect(phases).not.toContain('renaming');
        expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
      });

      it('mode=undefined (pointer/Library Import) + fileFormat set: does NOT call setPhase(renaming) or fs.rename', async () => {
        const fs = await import('node:fs/promises');
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        adapter = new ManualImportAdapter(deps);

        const payload: ManualImportJobPayload = { path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author' };
        const job = makeJob({ metadata: JSON.stringify(payload) });
        await adapter.process(job, ctx);

        const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
        expect(phases).not.toContain('renaming');
        expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
      });

      it('rename rollback: Nth fs.rename rejects, helper rewinds completed renames in reverse', async () => {
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3', 'b.mp3', 'c.mp3']);
        // Forward renames produce: a→Test Book, b→Test Book (2), c→Test Book (3).
        // Rollback after 3rd fails: reverses b→Test Book (2) and a→Test Book (only the completed pair).
        vi.mocked(fs.rename)
          .mockResolvedValueOnce(undefined) // a.mp3 → Test Book.mp3
          .mockResolvedValueOnce(undefined) // b.mp3 → Test Book (2).mp3
          .mockRejectedValueOnce(new Error('ENOSPC')) // c.mp3 → Test Book (3).mp3 fails
          .mockResolvedValueOnce(undefined) // rollback: Test Book (2).mp3 → b.mp3
          .mockResolvedValueOnce(undefined); // rollback: Test Book.mp3 → a.mp3

        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await expect(adapter.process(job, ctx)).rejects.toThrow('ENOSPC');

        // 3 forward + 2 rollback = 5 total
        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(5);
        const calls = vi.mocked(fs.rename).mock.calls;
        // Forward calls
        expect(calls[0].map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book.mp3`]);
        expect(calls[1].map(normPath)).toEqual(
          [`${TARGET_PATH}/b.mp3`, `${TARGET_PATH}/Test Book (2).mp3`]);
        expect(calls[2].map(normPath)).toEqual(
          [`${TARGET_PATH}/c.mp3`, `${TARGET_PATH}/Test Book (3).mp3`]);
        // Rollback calls (reverse order, swapped from/to)
        expect(calls[3].map(normPath)).toEqual(
          [`${TARGET_PATH}/Test Book (2).mp3`, `${TARGET_PATH}/b.mp3`]);
        expect(calls[4].map(normPath)).toEqual(
          [`${TARGET_PATH}/Test Book.mp3`, `${TARGET_PATH}/a.mp3`]);
      });

      it('mode=copy + fileFormat set + renameFilesWithTemplate throws: adapter catches, marks failed, re-throws', async () => {
        const fs = await import('node:fs/promises');
        const { safeEmit } = await import('../../utils/safe-emit.js');
        await mockReaddirAudioFiles(['a.mp3']);
        vi.mocked(fs.rename).mockRejectedValueOnce(new Error('ENOSPC'));
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await expect(adapter.process(job, ctx)).rejects.toThrow('ENOSPC');

        expect(vi.mocked(safeEmit)).toHaveBeenCalledWith(
          expect.anything(), 'book_status_change',
          expect.objectContaining({ book_id: 42, new_status: 'failed' }),
          expect.anything(),
        );
        expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
          eventType: 'import_failed',
          reason: { error: 'ENOSPC' },
        }));
      });

      it('mode=copy + fileFormat=\'{narrator}\' + bookService.getById returns narrators: rendered filename uses primary narrator', async () => {
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3']);
        const settingsSvc = makeRenameSettingsService('{narrator}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([
          { id: 1, name: 'Jane Narrator', asin: null },
          { id: 2, name: 'John Reader', asin: null },
        ]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fs.rename).mock.calls[0].map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Jane Narrator.mp3`]);
      });

      it('mode=copy + fileFormat set + bookService.getById returns null narrators: rename proceeds using bookRow fallbacks', async () => {
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3']);
        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = inject<BookService>({
          findDuplicate: vi.fn(), create: vi.fn(),
          getById: vi.fn().mockResolvedValue(null),
        });
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        expect(deps.bookService.getById).toHaveBeenCalledWith(42);
        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fs.rename).mock.calls[0].map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book.mp3`]);
      });
    });

    it('emits book_status_change SSE and records import_failed event on copy failure (#636 F2)', async () => {
      const { safeEmit } = await import('../../utils/safe-emit.js');
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');
      vi.mocked(streamCopyWithProgress).mockRejectedValueOnce(new Error('Disk full'));

      const job = makeJob();
      await expect(adapter.process(job, ctx)).rejects.toThrow('Disk full');

      expect(vi.mocked(safeEmit)).toHaveBeenCalledWith(
        mockBroadcaster,
        'book_status_change',
        expect.objectContaining({ book_id: 42, old_status: 'importing', new_status: 'failed' }),
        expect.anything(),
      );

      expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'import_failed',
        bookId: 42,
        source: 'manual',
        downloadId: null,
        reason: { error: 'Disk full' },
      }));
    });

    it('failure path: forwards narratorName from payload.metadata.narrators[0] (#672)', async () => {
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');
      vi.mocked(streamCopyWithProgress).mockRejectedValueOnce(new Error('Disk full'));

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
        mode: 'copy',
        metadata: {
          title: 'Test Book',
          authors: [{ name: 'Author' }],
          narrators: ['Alice', 'Bob'],
        },
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });

      await expect(adapter.process(job, ctx)).rejects.toThrow('Disk full');

      expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'import_failed',
        source: 'manual',
        bookTitle: 'Test Book',
        narratorName: 'Alice',
        downloadId: null,
      }));
    });

    it('failure path: narratorName is null when payload.metadata is undefined (#672)', async () => {
      const { streamCopyWithProgress } = await import('../streaming-copy.helpers.js');
      vi.mocked(streamCopyWithProgress).mockRejectedValueOnce(new Error('Disk full'));

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
        mode: 'copy',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });

      await expect(adapter.process(job, ctx)).rejects.toThrow('Disk full');

      expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'import_failed',
        source: 'manual',
        narratorName: null,
      }));
    });
  });
});
