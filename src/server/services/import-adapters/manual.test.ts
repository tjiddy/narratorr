import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Dirent, Stats } from 'node:fs';
import { join, extname } from 'node:path';
import { inject, createMockSettingsService } from '../../__tests__/helpers.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { OwnedRecordingError, type BookService } from '../book.service.js';
import type { BookImportService } from '../book-import.service.js';
import type { SettingsService } from '../settings.service.js';
import type { EventHistoryService } from '../event-history.service.js';
import type { EventBroadcasterService } from '../event-broadcaster.service.js';
import type { EnrichmentDeps } from '../enrichment-orchestration.helpers.js';
import type { ImportPipelineDeps } from '../import-orchestration.helpers.js';
import type { ImportAdapterContext, ImportJob, ManualImportJobPayload } from './types.js';
import { ManualImportAdapter } from './manual.js';
import * as importOrchestration from '../import-orchestration.helpers.js';
import { writeOpfForImportWithinAdmissionLock } from '../../utils/opf-writer.js';

// Keep pipeline copy/rename real while mocking fs, audio staging, and sizing so adapter↔helper seam regressions surface.
// Lower-level filtering/streaming has dedicated suites. Only #1740 spies on pipeline copyToLibrary because occupied-target
// edition-label derivation is impractical here; afterEach restores that spy even when process rejects.

vi.mock('../enrichment-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('../enrichment-orchestration.helpers.js')),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: true }),
}));

vi.mock('../library-scan.helpers.js', () => ({
  getAudioStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSize: 100_000 }),
}));

// Mock the shared audio copier while preserving staged-swap and marker helpers (#1602).
vi.mock('../../utils/import-steps.js', async () => ({
  ...(await vi.importActual('../../utils/import-steps.js')),
  copyToLibrary: vi.fn(),
}));

vi.mock('../../utils/import-helpers.js', async () => ({
  ...(await vi.importActual('../../utils/import-helpers.js')),
  getAudioPathSize: vi.fn(),
  // Mock streams here; import-helpers.test.ts covers real disc-group flattening.
  copyDiscGroup: vi.fn(),
}));

vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual('node:fs/promises')),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  readdir: vi.fn(),
  cp: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('../../utils/safe-emit.js', () => ({
  safeEmit: vi.fn(),
}));

// Mock managed cleanup at the adapter seam; real foreign-file and symlink safety uses tmpdirs elsewhere (#1598).
vi.mock('../../utils/delete-managed-files.js', () => ({
  deleteManagedBookFiles: vi.fn().mockResolvedValue({ deletedManaged: [], preservedForeign: [], failedManaged: [] }),
}));

// Assert OPF wiring here; opf-writer.test.ts covers reload, XML, and nonfatal writes (#1669).
vi.mock('../../utils/opf-writer.js', () => ({
  writeOpfForImportWithinAdmissionLock: vi.fn().mockResolvedValue(undefined),
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

// Normalize native join output before comparing with POSIX fixtures.
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

// Derived from default library settings and makeJob payload.
const TARGET_PATH = '/library/Author/Test Book';

describe('ManualImportAdapter', () => {
  let adapter: ManualImportAdapter;
  let deps: ImportPipelineDeps;
  let ctx: ImportAdapterContext;
  let mockDb: ReturnType<typeof createMockDb>;
  let mockEventHistory: { create: ReturnType<typeof vi.fn> };
  let mockBroadcaster: { emit: ReturnType<typeof vi.fn> };
  let mockConnectorService: { notifyRefresh: ReturnType<typeof vi.fn> };
  let setPhase: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const fs = await import('node:fs/promises');
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([] as never);
    vi.mocked(fs.cp).mockResolvedValue(undefined);
    // Fake /audiobooks sources (extension means file); delegate target/marker probes so ENOENT recovery stays real (#1602).
    vi.mocked(fs.stat).mockImplementation((async (p: Parameters<typeof realFs.stat>[0]) => {
      const path = String(p);
      if (path.startsWith('/audiobooks')) {
        const isFile = extname(path) !== '';
        return { isFile: () => isFile, isDirectory: () => !isFile, size: 1000 } as Stats;
      }
      return realFs.stat(p);
    }) as typeof realFs.stat);

    const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
    vi.mocked(stageSourceAudio).mockResolvedValue(undefined);

    const { getAudioPathSize } = await import('../../utils/import-helpers.js');
    // Reset the once-queue, seed target gate=0, then equal sizes; clearAllMocks does not drain queued responses (#1287).
    vi.mocked(getAudioPathSize).mockReset();
    vi.mocked(getAudioPathSize).mockResolvedValue(100);
    vi.mocked(getAudioPathSize).mockResolvedValueOnce(0);

    mockDb = createMockDb();
    mockEventHistory = { create: vi.fn().mockResolvedValue({}) };
    mockBroadcaster = { emit: vi.fn() };
    mockConnectorService = { notifyRefresh: vi.fn().mockResolvedValue(undefined) };
    const log = createMockLogger();
    const mockSettingsService = createMockSettingsService({ library: { path: '/library', fileFormat: '' } });

    deps = {
      db: inject<Db>(mockDb),
      log,
      bookService: inject<BookService>({ findDuplicate: vi.fn(), create: vi.fn(), getById: vi.fn().mockResolvedValue(null) }),
      bookImportService: inject<BookImportService>({ enqueue: vi.fn().mockResolvedValue({ jobId: 1 }) }),
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
      connectorService: inject<never>(mockConnectorService),
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

  // Restore narrow pipeline spies even after rejection; clearAllMocks does not uninstall them.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('process', () => {
    it('happy path: processes book — updates status to imported and records event', async () => {
      const job = makeJob();
      await adapter.process(job, ctx);

      const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
      expect(phases).toContain('analyzing');
      expect(phases).toContain('copying');
      expect(phases).toContain('fetching_metadata');

      // Phase/event assertions miss a no-op promotion; pin the imported status write directly (#1446).
      const statusUpdateSet = (mockDb.update.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> }).set;
      const statusCall = statusUpdateSet.mock.calls.find((c: unknown[]) => {
        const arg = c[0] as Record<string, unknown>;
        return arg && typeof arg === 'object' && arg.status === 'imported';
      });
      expect(statusCall, 'expected a db.update(books).set({ status: "imported" }) write').toBeDefined();

      expect(mockEventHistory.create).toHaveBeenCalled();
    });

    it('mode=copy: enqueues a connector refresh with reason "import"', async () => {
      const job = makeJob();
      await adapter.process(job, ctx);

      expect(mockConnectorService.notifyRefresh).toHaveBeenCalledWith('import', [
        expect.objectContaining({ bookId: 42, title: 'Test Book', libraryPath: TARGET_PATH }),
      ]);
    });

    it('pointer mode (in-place adopt, no mode): enqueues a connector refresh with reason "adopt"', async () => {
      const job = makeJob({ metadata: JSON.stringify({ path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author' }) });
      await adapter.process(job, ctx);

      expect(mockConnectorService.notifyRefresh).toHaveBeenCalledWith('adopt', [
        expect.objectContaining({ bookId: 42, title: 'Test Book', libraryPath: '/audiobooks/Author/Title' }),
      ]);
    });

    describe('OPF sidecar (#1669)', () => {
      function makeOpfAdapter(writeOpf: boolean): ManualImportAdapter {
        const settings = createMockSettingsService({ library: { path: '/library', fileFormat: '' }, tagging: { writeOpf } });
        return new ManualImportAdapter({ ...deps, settingsService: inject<SettingsService>(settings) });
      }

      it('writes the OPF sidecar into the copy/move finalPath when writeOpf is enabled', async () => {
        await makeOpfAdapter(true).process(makeJob(), ctx);

        expect(writeOpfForImportWithinAdmissionLock).toHaveBeenCalledTimes(1);
        const arg = vi.mocked(writeOpfForImportWithinAdmissionLock).mock.calls[0]![0];
        expect(arg.enabled).toBe(true);
        expect(arg.bookId).toBe(42);
        expect(arg.bookService).toBe(deps.bookService);
        expect(normPath(arg.bookFolder)).toBe(TARGET_PATH);
      });

      it('opts the manual-import call site into divergence preservation as source `manual` (#2297 AC9/AC15)', async () => {
        await makeOpfAdapter(true).process(makeJob(), ctx);

        // A hard-coded 'auto' in the writer would attribute an operator's import to the wrong path.
        expect(vi.mocked(writeOpfForImportWithinAdmissionLock).mock.calls[0]![0].preserve)
          .toEqual({ source: 'manual', eventHistory: deps.eventHistory });
      });

      it('writes the OPF sidecar into the pointer/adopt finalPath (the source path) when enabled', async () => {
        const job = makeJob({ metadata: JSON.stringify({ path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author' }) });
        await makeOpfAdapter(true).process(job, ctx);

        const arg = vi.mocked(writeOpfForImportWithinAdmissionLock).mock.calls[0]![0];
        expect(arg.enabled).toBe(true);
        expect(normPath(arg.bookFolder)).toBe('/audiobooks/Author/Title');
      });

      it('passes enabled:false to the OPF helper when writeOpf is disabled (default)', async () => {
        await adapter.process(makeJob(), ctx);

        expect(writeOpfForImportWithinAdmissionLock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, bookId: 42 }));
      });

      it('OPF write failure is nonfatal — import still completes and a warning is logged', async () => {
        vi.mocked(writeOpfForImportWithinAdmissionLock).mockRejectedValueOnce(new Error('disk full'));

        await expect(makeOpfAdapter(true).process(makeJob(), ctx)).resolves.toBeUndefined();
        expect(mockConnectorService.notifyRefresh).toHaveBeenCalled();
        expect(deps.log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ bookId: 42 }),
          expect.stringContaining('continuing'),
        );
      });
    });

    it('mode=copy: forwards the source stats to stageSourceAudio (the copier mkdirs the target itself)', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      const job = makeJob();
      await adapter.process(job, ctx);

      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
        sourcePath: '/audiobooks/Author/Title',
        targetPath: TARGET_PATH,
        sourceStats: expect.objectContaining({ isDirectory: expect.any(Function) }),
      }));
    });

    it('mode=copy: invokes stageSourceAudio with (payload.path, target, callback)', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      const job = makeJob();
      await adapter.process(job, ctx);

      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
        sourcePath: '/audiobooks/Author/Title',
        targetPath: TARGET_PATH,
        onProgress: expect.any(Function),
      }));
    });

    it('mode=move: routes source cleanup through deleteManagedBookFiles after copy verification (#1598)', async () => {
      const { deleteManagedBookFiles } = await import('../../utils/delete-managed-files.js');

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author', mode: 'move',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });
      await adapter.process(job, ctx);

      expect(vi.mocked(deleteManagedBookFiles)).toHaveBeenCalledWith(
        '/audiobooks/Author/Title', expect.any(String), expect.anything(), { assertInsideLibrary: false },
      );
    });

    it('pointer mode: metadata mode is undefined — skips copy phase and stageSourceAudio', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });

      await adapter.process(job, ctx);

      const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
      expect(phases).toContain('analyzing');
      expect(phases).not.toContain('copying');
      expect(phases).toContain('fetching_metadata');
      expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();
    });

    describe('coalesced disc-group rows (#1272)', () => {
      // Use native join output to match reconstruction on Windows and POSIX.
      const MEMBER_PATHS = [
        join('/audiobooks', 'Author - Book Disc 1 of 3'),
        join('/audiobooks', 'Author - Book Disc 2 of 3'),
        join('/audiobooks', 'Author - Book Disc 3 of 3'),
      ];

      /** Mock parent listing and per-sibling audio probes; audioless entries return only cover art (#1280). */
      async function mockSiblingTree(names: string[], audioless: string[] = []): Promise<void> {
        const fs = await import('node:fs/promises');
        vi.mocked(fs.readdir).mockImplementation(async (p: unknown) => {
          // Normalize native sibling probes into the POSIX-keyed fixture.
          const key = String(p).split('\\').join('/');
          if (key === '/audiobooks') return names.map(n => makeDirent(n, false)) as never;
          const name = key.slice('/audiobooks/'.length);
          return (audioless.includes(name)
            ? [makeDirent('cover.jpg', true)]
            : [makeDirent('track.mp3', true)]) as never;
        });
      }

      async function mockDiscSiblings(): Promise<void> {
        await mockSiblingTree([
          'Author - Book Disc 1 of 3',
          'Author - Book Disc 2 of 3',
          'Author - Book Disc 3 of 3',
        ]);
      }

      it('mode=copy: reconstructs the group and flattens ALL members via copyDiscGroup', async () => {
        await mockDiscSiblings();
        const { copyDiscGroup, getAudioPathSize } = await import('../../utils/import-helpers.js');
        const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
        vi.mocked(getAudioPathSize)
          .mockResolvedValueOnce(100).mockResolvedValueOnce(100).mockResolvedValueOnce(100)
          .mockResolvedValueOnce(300);

        const payload: ManualImportJobPayload = {
          path: MEMBER_PATHS[0]!, title: 'Test Book', authorName: 'Author', mode: 'copy',
        };
        await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);

        expect(vi.mocked(copyDiscGroup)).toHaveBeenCalledWith(MEMBER_PATHS, TARGET_PATH, expect.any(Function));
        expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();
        // First target read is the empty-target gate; remaining reads verify every member and aggregate target (AC2/#1287).
        expect(vi.mocked(getAudioPathSize).mock.calls).toEqual([
          [TARGET_PATH],
          [MEMBER_PATHS[0]],
          [MEMBER_PATHS[1]],
          [MEMBER_PATHS[2]],
          [TARGET_PATH],
        ]);
      });

      it('mode=move: cleans every reconstructed member folder via deleteManagedBookFiles after copy (#1598)', async () => {
        await mockDiscSiblings();
        const { deleteManagedBookFiles } = await import('../../utils/delete-managed-files.js');
        const { getAudioPathSize } = await import('../../utils/import-helpers.js');
        vi.mocked(getAudioPathSize)
          .mockResolvedValueOnce(100).mockResolvedValueOnce(100).mockResolvedValueOnce(100)
          .mockResolvedValueOnce(300);

        const payload: ManualImportJobPayload = {
          path: MEMBER_PATHS[0]!, title: 'Test Book', authorName: 'Author', mode: 'move',
        };
        await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);

        for (const member of MEMBER_PATHS) {
          expect(vi.mocked(deleteManagedBookFiles)).toHaveBeenCalledWith(
            member, expect.any(String), expect.anything(), { assertInsideLibrary: false },
          );
        }
        // First target read is the empty-target gate; remaining reads verify every member and aggregate target (AC2/#1287).
        expect(vi.mocked(getAudioPathSize).mock.calls).toEqual([
          [TARGET_PATH],
          [MEMBER_PATHS[0]],
          [MEMBER_PATHS[1]],
          [MEMBER_PATHS[2]],
          [TARGET_PATH],
        ]);
      });

      it('pointer mode: rejects a disc-group row instead of silently registering Disc 1', async () => {
        await mockDiscSiblings();
        const { copyDiscGroup } = await import('../../utils/import-helpers.js');
        const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

        const payload: ManualImportJobPayload = {
          path: MEMBER_PATHS[0]!, title: 'Test Book', authorName: 'Author',
        };

        await expect(adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx))
          .rejects.toThrow(/multi-disc set/i);
        expect(vi.mocked(copyDiscGroup)).not.toHaveBeenCalled();
        expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();
      });

      it('mode=copy: inconsistent-total sibling set falls back to single-source copy, not a flatten', async () => {
        await mockSiblingTree(['Author - Book Disc 1 of 10', 'Author - Book Disc 2 of 8']);
        const { copyDiscGroup } = await import('../../utils/import-helpers.js');
        const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Author - Book Disc 1 of 10', title: 'Test Book', authorName: 'Author', mode: 'copy',
        };
        await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);

        expect(vi.mocked(copyDiscGroup)).not.toHaveBeenCalled();
        expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
          sourcePath: '/audiobooks/Author - Book Disc 1 of 10',
          targetPath: TARGET_PATH,
          onProgress: expect.any(Function),
        }));
      });

      it('pointer mode: AUDIO-bearing partial-marker sibling set is NOT rejected (discovery left it ungrouped)', async () => {
        await mockSiblingTree([
          'Author - Book Disc 1 of 3',
          'Author - Book Disc 2 of 3',
          'Author - Book Bonus Material',
        ]);
        const { copyDiscGroup } = await import('../../utils/import-helpers.js');

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Author - Book Disc 1 of 3', title: 'Test Book', authorName: 'Author',
        };
        await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);

        const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
        expect(phases).toContain('fetching_metadata');
        expect(vi.mocked(copyDiscGroup)).not.toHaveBeenCalled();
      });

      it('mode=copy: an AUDIOLESS stem-sharing sibling no longer drops discs — flattens ALL members (#1280)', async () => {
        // Audioless stem siblings once broke grouping and silently copied only Disc 1; filter them before the guard (#1280).
        await mockSiblingTree(
          [
            'Author - Book Disc 1 of 3',
            'Author - Book Disc 2 of 3',
            'Author - Book Disc 3 of 3',
            'Author - Book Artwork',
          ],
          ['Author - Book Artwork'],
        );
        const { copyDiscGroup, getAudioPathSize } = await import('../../utils/import-helpers.js');
        const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
        vi.mocked(getAudioPathSize)
          .mockResolvedValueOnce(100).mockResolvedValueOnce(100).mockResolvedValueOnce(100)
          .mockResolvedValueOnce(300);

        const payload: ManualImportJobPayload = {
          path: MEMBER_PATHS[0]!, title: 'Test Book', authorName: 'Author', mode: 'copy',
        };
        await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);

        expect(vi.mocked(copyDiscGroup)).toHaveBeenCalledWith(MEMBER_PATHS, TARGET_PATH, expect.any(Function));
        expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();

        // Exact reads distinguish full-group verification from the old anchor-only check (AC2/#1287).
        expect(vi.mocked(getAudioPathSize).mock.calls).toEqual([
          [TARGET_PATH],
          [MEMBER_PATHS[0]],
          [MEMBER_PATHS[1]],
          [MEMBER_PATHS[2]],
          [TARGET_PATH],
        ]);
      });
    });

    describe('single-file payloads (issue #982)', () => {
      // Select the path/size write from the shared set log, excluding the separate status write.
      function findPathSizeUpdate(): { path: unknown; size: unknown } | undefined {
        const updateResults = mockDb.update.mock.results;
        if (updateResults.length === 0) return undefined;
        const setMock = (updateResults[0]!.value as { set: ReturnType<typeof vi.fn> }).set;
        const call = setMock.mock.calls.find((c: unknown[]) => {
          const arg = c[0] as Record<string, unknown>;
          return arg && typeof arg === 'object' && 'path' in arg && 'size' in arg;
        });
        return call ? (call[0] as { path: unknown; size: unknown }) : undefined;
      }

      it('pointer mode + file-path payload: persists source file path with the file byte size', async () => {
        const { getAudioStats } = await import('../library-scan.helpers.js');
        vi.mocked(getAudioStats).mockResolvedValueOnce({ fileCount: 1, totalSize: 12_345 });

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Doctor Sleep.m4b',
          title: 'Test Book',
          authorName: 'Author',
        };
        const job = makeJob({ metadata: JSON.stringify(payload) });

        await adapter.process(job, ctx);

        expect(vi.mocked(getAudioStats)).toHaveBeenCalledWith(
          '/audiobooks/Doctor Sleep.m4b',
          expect.anything(),
        );

        const persisted = findPathSizeUpdate();
        expect(persisted).toMatchObject({
          path: '/audiobooks/Doctor Sleep.m4b',
          size: 12_345,
        });
      });

      it('mode=copy + file-path payload: stageSourceAudio receives the file source, persists target dir and copied-file size', async () => {
        const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
        const { getAudioStats } = await import('../library-scan.helpers.js');
        vi.mocked(getAudioStats).mockResolvedValueOnce({ fileCount: 1, totalSize: 67_890 });

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Doctor Sleep.m4b',
          title: 'Test Book',
          authorName: 'Author',
          mode: 'copy',
        };
        const job = makeJob({ metadata: JSON.stringify(payload) });

        await adapter.process(job, ctx);

        expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
          sourcePath: '/audiobooks/Doctor Sleep.m4b',
          targetPath: TARGET_PATH,
          sourceStats: expect.objectContaining({ isFile: expect.any(Function) }),
          onProgress: expect.any(Function),
        }));

        const persisted = findPathSizeUpdate();
        expect(persisted).toMatchObject({
          path: TARGET_PATH,
          size: 67_890,
        });
      });

      it('mode=move + file-path payload: persists target dir + size and removes the source file', async () => {
        const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
        const { getAudioStats } = await import('../library-scan.helpers.js');
        vi.mocked(getAudioStats).mockResolvedValueOnce({ fileCount: 1, totalSize: 33_333 });

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Doctor Sleep.m4b',
          title: 'Test Book',
          authorName: 'Author',
          mode: 'move',
        };
        const job = makeJob({ metadata: JSON.stringify(payload) });

        await adapter.process(job, ctx);

        expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
          sourcePath: '/audiobooks/Doctor Sleep.m4b',
          targetPath: TARGET_PATH,
          onProgress: expect.any(Function),
        }));

        const { deleteManagedBookFiles } = await import('../../utils/delete-managed-files.js');
        expect(vi.mocked(deleteManagedBookFiles)).toHaveBeenCalledWith(
          '/audiobooks/Doctor Sleep.m4b', expect.any(String), expect.anything(), { assertInsideLibrary: false },
        );

        const persisted = findPathSizeUpdate();
        expect(persisted).toMatchObject({
          path: TARGET_PATH,
          size: 33_333,
        });
      });
    });

    it('throws when bookId is null (before any fs primitive or stageSourceAudio call)', async () => {
      const fs = await import('node:fs/promises');
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      const job = makeJob({ bookId: null });

      await expect(adapter.process(job, ctx)).rejects.toThrow('ManualImportAdapter requires a bookId');
      expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
    });

    it('throws when book row not found — before any fs primitive or stageSourceAudio call', async () => {
      const fs = await import('node:fs/promises');
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      mockDb.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });
      ctx.db = inject<Db>(mockDb);

      const job = makeJob();
      await expect(adapter.process(job, ctx)).rejects.toThrow('Book 42 not found');
      expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
    });

    it('hydrates ManualImportJobPayload from job.metadata JSON including mode', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
      const job = makeJob();
      await adapter.process(job, ctx);

      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalled();
    });

    it('onProgress wiring during copy: forwards captured callback values to ctx.emitProgress', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      vi.mocked(stageSourceAudio).mockImplementationOnce(async ({ onProgress }) => {
        onProgress?.(0.25, { current: 25, total: 100 });
        onProgress?.(0.5, { current: 50, total: 100 });
        onProgress?.(1.0, { current: 100, total: 100 });
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

        // Real copy takes one snapshot; adapter rename must add exactly one more, not two.
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

        // Colliding stems number every file, including the first (#1192).
        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(3);
        const calls = vi.mocked(fs.rename).mock.calls;
        expect(calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book (1).mp3`]);
        expect(calls[1]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/b.mp3`, `${TARGET_PATH}/Test Book (2).mp3`]);
        expect(calls[2]!.map(normPath)).toEqual(
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
        // The third forward rename fails; rollback unwinds the two completed pairs in reverse.
        vi.mocked(fs.rename)
          .mockResolvedValueOnce(undefined) // a.mp3 → Test Book (1).mp3
          .mockResolvedValueOnce(undefined) // b.mp3 → Test Book (2).mp3
          .mockRejectedValueOnce(new Error('ENOSPC')) // c.mp3 → Test Book (3).mp3 fails
          .mockResolvedValueOnce(undefined) // rollback: Test Book (2).mp3 → b.mp3
          .mockResolvedValueOnce(undefined); // rollback: Test Book (1).mp3 → a.mp3

        const settingsSvc = makeRenameSettingsService('{title}');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = makeBookServiceWithNarrators([]);
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await expect(adapter.process(job, ctx)).rejects.toThrow('ENOSPC');

        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(5);
        const calls = vi.mocked(fs.rename).mock.calls;
        expect(calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book (1).mp3`]);
        expect(calls[1]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/b.mp3`, `${TARGET_PATH}/Test Book (2).mp3`]);
        expect(calls[2]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/c.mp3`, `${TARGET_PATH}/Test Book (3).mp3`]);
        expect(calls[3]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/Test Book (2).mp3`, `${TARGET_PATH}/b.mp3`]);
        expect(calls[4]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/Test Book (1).mp3`, `${TARGET_PATH}/a.mp3`]);
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

      // Forced OwnedRecordingError belongs to the worker's refused disposition; rethrow without generic failure side effects (#1736).
      it('mode=copy + forceImport + copyToLibrary throws OwnedRecordingError: rethrows typed error, skips generic failure side effects', async () => {
        const { safeEmit } = await import('../../utils/safe-emit.js');
        const ownedError = new OwnedRecordingError({ existingBookId: 99, title: 'Owned', reason: 'recording-review' });
        vi.spyOn(importOrchestration, 'copyToLibrary').mockRejectedValue(ownedError);

        const job = makeJob({ metadata: JSON.stringify({ path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author', mode: 'copy', forceImport: true }) });
        await expect(adapter.process(job, ctx)).rejects.toBe(ownedError);

        expect(vi.mocked(safeEmit)).not.toHaveBeenCalledWith(
          expect.anything(), 'book_status_change',
          expect.objectContaining({ new_status: 'failed' }),
          expect.anything(),
        );
        expect(mockEventHistory.create).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'import_failed' }));
      });

      // Without forceImport, OwnedRecordingError is ordinary failure; suppressing side effects would mislabel it as force-refused (#1736 F1).
      it('mode=copy WITHOUT forceImport + copyToLibrary throws OwnedRecordingError: keeps the generic failure side effects', async () => {
        const { safeEmit } = await import('../../utils/safe-emit.js');
        const ownedError = new OwnedRecordingError({ existingBookId: 99, title: 'Owned', reason: 'recording-review' });
        vi.spyOn(importOrchestration, 'copyToLibrary').mockRejectedValue(ownedError);

        const job = makeJob();
        await expect(adapter.process(job, ctx)).rejects.toBe(ownedError);

        expect(vi.mocked(safeEmit)).toHaveBeenCalledWith(
          expect.anything(), 'book_status_change',
          expect.objectContaining({ book_id: 42, new_status: 'failed' }),
          expect.anything(),
        );
        expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'import_failed' }));
      });

      it('mode=copy + copyToLibrary throws a non-Owned error: keeps the generic failure side effects', async () => {
        const { safeEmit } = await import('../../utils/safe-emit.js');
        vi.spyOn(importOrchestration, 'copyToLibrary').mockRejectedValue(new Error('disk full'));

        const job = makeJob();
        await expect(adapter.process(job, ctx)).rejects.toThrow('disk full');

        expect(vi.mocked(safeEmit)).toHaveBeenCalledWith(
          expect.anything(), 'book_status_change',
          expect.objectContaining({ book_id: 42, new_status: 'failed' }),
          expect.anything(),
        );
        expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
          eventType: 'import_failed',
          reason: { error: 'disk full' },
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
        expect(vi.mocked(fs.rename).mock.calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Jane Narrator.mp3`]);
      });

      it('mode=copy + fileFormat=\'{title} ({edition})\' + copyToLibrary derives editionLabel: rename uses the FRESH copy-result label, not the stale getById value (#1740)', async () => {
        // Rename precedes label persistence, so the current copy result must beat stale hydrated metadata (#1740).
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3']);
        vi.spyOn(importOrchestration, 'copyToLibrary')
          .mockResolvedValue({ targetPath: TARGET_PATH, editionLabel: 'Full Cast' });
        const settingsSvc = makeRenameSettingsService('{title} ({edition})');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = inject<BookService>({
          findDuplicate: vi.fn(), create: vi.fn(),
          getById: vi.fn().mockResolvedValue({
            id: 1, title: 'Test Book', seriesName: null, seriesPosition: null,
            narrators: [], authors: [{ id: 1, name: 'Author', asin: null }],
            publishedDate: '2024-01-15', path: '/library/Author/Title',
            editionLabel: null, status: 'importing', size: 100_000, genres: [],
          }),
        });
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fs.rename).mock.calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book (Full Cast).mp3`]);
      });

      it('mode=copy + fileFormat=\'{title} ({edition})\' + no copy-result label + getById returns editionLabel: falls back to the stored label (#1740)', async () => {
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3']);
        const settingsSvc = makeRenameSettingsService('{title} ({edition})');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = inject<BookService>({
          findDuplicate: vi.fn(), create: vi.fn(),
          getById: vi.fn().mockResolvedValue({
            id: 1, title: 'Test Book', seriesName: null, seriesPosition: null,
            narrators: [], authors: [{ id: 1, name: 'Author', asin: null }],
            publishedDate: '2024-01-15', path: '/library/Author/Title',
            editionLabel: 'Unabridged', status: 'importing', size: 100_000, genres: [],
          }),
        });
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fs.rename).mock.calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book (Unabridged).mp3`]);
      });

      it('mode=copy + fileFormat=\'{title} ({edition})\' + null editionLabel: renders no stray brackets (#1712 F2)', async () => {
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3']);
        const settingsSvc = makeRenameSettingsService('{title} ({edition})');
        deps.settingsService = inject<SettingsService>(settingsSvc);
        deps.bookService = inject<BookService>({
          findDuplicate: vi.fn(), create: vi.fn(),
          getById: vi.fn().mockResolvedValue({
            id: 1, title: 'Test Book', seriesName: null, seriesPosition: null,
            narrators: [], authors: [{ id: 1, name: 'Author', asin: null }],
            publishedDate: '2024-01-15', path: '/library/Author/Title',
            editionLabel: null, status: 'importing', size: 100_000, genres: [],
          }),
        });
        adapter = new ManualImportAdapter(deps);

        const job = makeJob();
        await adapter.process(job, ctx);

        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fs.rename).mock.calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book.mp3`]);
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
        expect(vi.mocked(fs.rename).mock.calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book.mp3`]);
      });
    });

    it('emits book_status_change SSE and records import_failed event on copy failure (#636 F2)', async () => {
      const { safeEmit } = await import('../../utils/safe-emit.js');
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
      vi.mocked(stageSourceAudio).mockRejectedValueOnce(new Error('Disk full'));

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
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
      vi.mocked(stageSourceAudio).mockRejectedValueOnce(new Error('Disk full'));

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

    it('throws descriptive error with JSON parse cause when metadata is unparseable', async () => {
      const job = makeJob({ id: 7, metadata: '{' });

      try {
        await adapter.process(job, ctx);
        expect.fail('expected adapter.process to throw');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('Invalid manual import payload for job 7');
        expect((err as Error).message).toContain('malformed JSON');
        expect((err as Error).cause).toBeInstanceOf(SyntaxError);
      }
    });

    it('throws descriptive error with Zod cause when metadata shape mismatches (missing path)', async () => {
      const job = makeJob({ id: 11, metadata: JSON.stringify({ title: 'Missing Path' }) });

      try {
        await adapter.process(job, ctx);
        expect.fail('expected adapter.process to throw');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('Invalid manual import payload for job 11');
        expect((err as Error).message).toContain('shape mismatch');
        expect((err as Error).cause).toBeDefined();
      }
    });

    it('parseManualPayload accepts narrators and seriesPosition (incl. 0) (#1028)', async () => {
      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
        narrators: ['Jim Dale'],
        seriesName: 'Discworld',
        seriesPosition: 0,
        mode: 'copy',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });
      await adapter.process(job, ctx);
      expect(setPhase).toHaveBeenCalled();
    });

    it('worker rehydration: persisted seriesPosition: 0 reaches copyToLibrary target path via {seriesPosition} token (AC9/F2/#1028)', async () => {
      // Include {seriesPosition}; otherwise dropping the conditional spread has no observable target effect.
      const settingsSvc = createMockSettingsService({
        library: { path: '/library', folderFormat: '{author}/{series} #{seriesPosition}/{title}', fileFormat: '' },
      });
      deps.settingsService = inject<SettingsService>(settingsSvc);
      adapter = new ManualImportAdapter(deps);

      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Discworld 0/Test Book',
        title: 'Test Book',
        authorName: 'Author',
        seriesName: 'Discworld',
        seriesPosition: 0,
        mode: 'copy',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });
      await adapter.process(job, ctx);

      const expectedTarget = '/library/Author/Discworld #0/Test Book';
      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
        sourcePath: payload.path,
        targetPath: expectedTarget,
        onProgress: expect.any(Function),
      }));
    });

    it('worker rehydration: a non-empty user series + paired position survives the strict schema round-trip and WINS over matched metadata in the copy target (#1927 F6/AC2)', async () => {
      // Exercise JSON→strict schema→item conversion→copy; the user pair must beat provider metadata at the persisted boundary.
      const settingsSvc = createMockSettingsService({
        library: { path: '/library', folderFormat: '{author}/{series} #{seriesPosition}/{title}', fileFormat: '' },
      });
      deps.settingsService = inject<SettingsService>(settingsSvc);
      adapter = new ManualImportAdapter(deps);

      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Custom Saga 7/Test Book',
        title: 'Test Book',
        authorName: 'Author',
        seriesName: 'Custom Saga',
        seriesPosition: 7,
        metadata: { title: 'Test Book', authors: [{ name: 'Author' }], seriesPrimary: { name: 'Provider Saga', position: 2 } },
        mode: 'copy',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });
      await adapter.process(job, ctx);

      const expectedTarget = '/library/Author/Custom Saga #7/Test Book';
      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
        sourcePath: payload.path,
        targetPath: expectedTarget,
      }));
    });

    it('worker rehydration: a whitespace-only seriesName defers to the matched metadata pair — no whitespace third state (#1927 F4/F10/AC5)', async () => {
      // Schema accepts whitespace; the server treats it absent and ignores orphan position 99 in favor of provider metadata.
      const settingsSvc = createMockSettingsService({
        library: { path: '/library', folderFormat: '{author}/{series} #{seriesPosition}/{title}', fileFormat: '' },
      });
      deps.settingsService = inject<SettingsService>(settingsSvc);
      adapter = new ManualImportAdapter(deps);

      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Whitespace/Test Book',
        title: 'Test Book',
        authorName: 'Author',
        seriesName: '   ',
        seriesPosition: 99,
        metadata: { title: 'Test Book', authors: [{ name: 'Author' }], seriesPrimary: { name: 'Provider Saga', position: 2 } },
        mode: 'copy',
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });
      await adapter.process(job, ctx);

      const expectedTarget = '/library/Author/Provider Saga #2/Test Book';
      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
        sourcePath: payload.path,
        targetPath: expectedTarget,
      }));
    });

    it('failure path: payload.narrators wins over payload.metadata.narrators[0] (F11/#1028)', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
      vi.mocked(stageSourceAudio).mockRejectedValueOnce(new Error('Disk full'));

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
        mode: 'copy',
        narrators: ['Jim Dale'],
        metadata: {
          title: 'Test Book',
          authors: [{ name: 'Author' }],
          narrators: ['Stephen Fry'],
        },
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });

      await expect(adapter.process(job, ctx)).rejects.toThrow('Disk full');

      expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'import_failed',
        narratorName: 'Jim Dale',
      }));
    });

    it('failure path: falls back to metadata narrator when item has none (regression guard) (#1028)', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
      vi.mocked(stageSourceAudio).mockRejectedValueOnce(new Error('Disk full'));

      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
        mode: 'copy',
        metadata: {
          title: 'Test Book',
          authors: [{ name: 'Author' }],
          narrators: ['Stephen Fry'],
        },
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });

      await expect(adapter.process(job, ctx)).rejects.toThrow('Disk full');

      expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'import_failed',
        narratorName: 'Stephen Fry',
      }));
    });

    it('imported event: payload.narrators wins as narratorName argument (F8/#1028)', async () => {
      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title',
        title: 'Test Book',
        authorName: 'Author',
        mode: 'copy',
        narrators: ['Jim Dale'],
        metadata: {
          title: 'Test Book',
          authors: [{ name: 'Author' }],
          narrators: ['Stephen Fry'],
        },
      };
      const job = makeJob({ metadata: JSON.stringify(payload) });

      await adapter.process(job, ctx);

      expect(mockEventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'imported',
        source: 'manual',
        narratorName: 'Jim Dale',
      }));
    });

    it('failure path: narratorName is null when payload.metadata is undefined (#672)', async () => {
      const { copyToLibrary: stageSourceAudio } = await import('../../utils/import-steps.js');
      vi.mocked(stageSourceAudio).mockRejectedValueOnce(new Error('Disk full'));

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

  // ImportSubmissionRunner computes narratorSource; this adapter only threads it through (#2158).
  // Resulting row behavior is covered end-to-end in import-opf-ladder.integration.test.ts.
  describe('narratorSource threading (#2158 AC8)', () => {
    async function processWith(extra: Partial<ManualImportJobPayload>) {
      const payload: ManualImportJobPayload = {
        path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author', mode: 'copy', ...extra,
      };
      await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);
      const { orchestrateBookEnrichment } = await import('../enrichment-orchestration.helpers.js');
      return vi.mocked(orchestrateBookEnrichment).mock.calls[0]![2];
    }

    it.each(['curated', 'provider', 'none'] as const)('forwards narratorSource=%s', async (narratorSource) => {
      expect(await processWith({ narratorSource })).toMatchObject({ narratorSource });
    });

    it('omits the key entirely when the payload carries no provenance (default-preserving)', async () => {
      // Older persisted jobs omit this key; preserve fill-empty semantics and sibling exact-argument mocks.
      expect(await processWith({})).not.toHaveProperty('narratorSource');
    });

    it('a narratorSource the schema does not know is rejected at parse, not silently forwarded', async () => {
      const payload = {
        path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author', mode: 'copy',
        narratorSource: 'invented',
      };
      await expect(adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx))
        .rejects.toThrow(/shape mismatch/);
    });
  });
});
