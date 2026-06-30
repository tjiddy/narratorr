import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dirent, Stats } from 'node:fs';
import { join, extname } from 'node:path';
import { inject, createMockSettingsService } from '../../__tests__/helpers.js';
import type { Db } from '../../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from '../book.service.js';
import type { BookImportService } from '../book-import.service.js';
import type { SettingsService } from '../settings.service.js';
import type { EventHistoryService } from '../event-history.service.js';
import type { EventBroadcasterService } from '../event-broadcaster.service.js';
import type { EnrichmentDeps } from '../enrichment-orchestration.helpers.js';
import type { ImportPipelineDeps } from '../import-orchestration.helpers.js';
import type { ImportAdapterContext, ImportJob, ManualImportJobPayload } from './types.js';
import { ManualImportAdapter } from './manual.js';
import * as importOrchestration from '../import-orchestration.helpers.js';
import { writeOpfForImport } from '../../utils/opf-writer.js';

// Boundary choice: this file mocks fs primitives + stageSourceAudio (the import-steps `copyToLibrary`
// the pipeline now calls per #1602) + getAudioPathSize, NOT the pipeline `copyToLibrary` /
// renameFilesWithTemplate. Real pipeline copyToLibrary and renameFilesWithTemplate run against these
// lower mocks, so a regression at the adapter↔helper seam (wrong source/target path, missing
// callback, broken rollback) surfaces here. The audio-only copier (`stageSourceAudio`) is mocked
// rather than its stream primitives because its dedicated tests (import-steps.test.ts,
// copy-to-library-progress.test.ts) exercise real audio-filtering + streaming behavior; here it is
// the copy boundary the pipeline forwards (sourcePath, targetPath, sourceStats, onProgress) into.
//
// Exception (#1740): the edition-threading test ("uses the FRESH copy-result label") narrowly
// `vi.spyOn`s the pipeline `copyToLibrary` to return a non-empty `editionLabel` — the only place
// that label is derived is the occupied-target disambiguation path, which is impractical to fake
// faithfully here. The spy is scoped to that single test and `mockRestore`d immediately after, so
// every other test keeps the real pipeline copier running against the lower mocks.

vi.mock('../enrichment-orchestration.helpers.js', async () => ({
  ...(await vi.importActual('../enrichment-orchestration.helpers.js')),
  orchestrateBookEnrichment: vi.fn().mockResolvedValue({ audioEnriched: true }),
}));

vi.mock('../library-scan.helpers.js', () => ({
  getAudioStats: vi.fn().mockResolvedValue({ fileCount: 3, totalSize: 100_000 }),
}));

// #1602: the empty-target fast path now reuses the import-steps `copyToLibrary` (aliased
// stageSourceAudio in the pipeline) — the SAME copier the populated-target staged swap uses — instead
// of streamCopyWithProgress. Mock it as the copy boundary; real audio-filtering/streaming lives in
// its own suites. Preserve every other import-steps export (stagedAudioReplace, marker helpers, …).
vi.mock('../../utils/import-steps.js', async () => ({
  ...(await vi.importActual('../../utils/import-steps.js')),
  copyToLibrary: vi.fn(),
}));

vi.mock('../../utils/import-helpers.js', async () => ({
  ...(await vi.importActual('../../utils/import-helpers.js')),
  getAudioPathSize: vi.fn(),
  // copyDiscGroup uses real fs streams when given a progress callback; mock it so the disc-group
  // wiring (reconstruct → flatten member set) is asserted without touching real fs. The actual
  // flattening behavior is covered in import-helpers.test.ts.
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

// #1598: empty-target move cleanup now routes through deleteManagedBookFiles (preserves foreign
// files + symlink-safe) instead of a blanket fs.rm. Mock it here so the adapter↔helper move-cleanup
// seam is asserted by the helper invocation — the real helper would lstat these fake paths to ENOENT.
// Its foreign-preservation/symlink behavior is covered against real tmpdirs in delete-managed-files.test.ts
// and import-orchestration.helpers.test.ts.
vi.mock('../../utils/delete-managed-files.js', () => ({
  deleteManagedBookFiles: vi.fn().mockResolvedValue({ deletedManaged: [], preservedForeign: [], failedManaged: [] }),
}));

// #1669: mock the OPF writer — the adapter-wiring (gate, finalPath, fresh bookId) is asserted via the
// spy; the writer's own behavior (fresh reload, XML shape, nonfatal write) lives in opf-writer.test.ts.
vi.mock('../../utils/opf-writer.js', () => ({
  writeOpfForImport: vi.fn().mockResolvedValue(undefined),
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
    // #1602: the pipeline now `stat`s the source (item.path) before handing it to stageSourceAudio.
    // Test sources live under /audiobooks (fake paths) — synthesize Stats for those (file when the
    // basename has an extension, e.g. Doctor Sleep.m4b; directory otherwise). Any other path (a
    // /library target/marker probed by recoverInterruptedCommit) delegates to the real stat so its
    // ENOENT-tolerant behavior is unchanged.
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
    // Source/target return equal sizes so target/source >= 0.99 verification passes.
    // mockReset drains any leftover *Once() queue from a prior test before we re-seed
    // (clearAllMocks does not — see CLAUDE.md). The first read is the #1287 pre-copy
    // target gate: default it to 0 (empty target) so standard tests exercise the
    // direct-copy fast path; the staged-swap tests below override the gate to > 0.
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

  describe('process', () => {
    it('happy path: processes book — updates status to imported and records event', async () => {
      const job = makeJob();
      await adapter.process(job, ctx);

      const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
      expect(phases).toContain('analyzing');
      expect(phases).toContain('copying');
      expect(phases).toContain('fetching_metadata');

      // Direct assertion on the helper-backed status promotion (#1446): the adapter
      // must write `status: 'imported'` via transitionBookStatus → db.update(books).set(...).
      // Without this, deleting/no-opping the promotion line still passes the phase/event
      // assertions above. The adapter calls set() twice (path/size, then status); grab the
      // status write from the shared set call log.
      const statusUpdateSet = (mockDb.update.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> }).set;
      const statusCall = statusUpdateSet.mock.calls.find((c: unknown[]) => {
        const arg = c[0] as Record<string, unknown>;
        return arg && typeof arg === 'object' && arg.status === 'imported';
      });
      expect(statusCall, 'expected a db.update(books).set({ status: "imported" }) write').toBeDefined();

      expect(mockEventHistory.create).toHaveBeenCalled();
    });

    // ── #1491 connector refresh hook ───────────────────────────────────────
    it('mode=copy: enqueues a connector refresh with reason "import"', async () => {
      const job = makeJob();
      await adapter.process(job, ctx);

      expect(mockConnectorService.notifyRefresh).toHaveBeenCalledWith('import', [
        expect.objectContaining({ bookId: 42, title: 'Test Book', libraryPath: TARGET_PATH }),
      ]);
    });

    it('pointer mode (in-place adopt, no mode): enqueues a connector refresh with reason "adopt"', async () => {
      // No `mode` key → pointer/adopt path; finalPath stays the source path.
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

        expect(writeOpfForImport).toHaveBeenCalledTimes(1);
        const arg = vi.mocked(writeOpfForImport).mock.calls[0]![0];
        expect(arg.enabled).toBe(true);
        expect(arg.bookId).toBe(42);
        expect(arg.bookService).toBe(deps.bookService);
        expect(normPath(arg.bookFolder)).toBe(TARGET_PATH);
      });

      it('writes the OPF sidecar into the pointer/adopt finalPath (the source path) when enabled', async () => {
        const job = makeJob({ metadata: JSON.stringify({ path: '/audiobooks/Author/Title', title: 'Test Book', authorName: 'Author' }) });
        await makeOpfAdapter(true).process(job, ctx);

        const arg = vi.mocked(writeOpfForImport).mock.calls[0]![0];
        expect(arg.enabled).toBe(true);
        expect(normPath(arg.bookFolder)).toBe('/audiobooks/Author/Title');
      });

      it('passes enabled:false to the OPF helper when writeOpf is disabled (default)', async () => {
        await adapter.process(makeJob(), ctx);

        expect(writeOpfForImport).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, bookId: 42 }));
      });

      it('OPF write failure is nonfatal — import still completes and a warning is logged', async () => {
        vi.mocked(writeOpfForImport).mockRejectedValueOnce(new Error('disk full'));

        await expect(makeOpfAdapter(true).process(makeJob(), ctx)).resolves.toBeUndefined();
        // Connector refresh after the OPF write still fires → import path was not aborted.
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

      // #1602: target creation is the audio-only copier's responsibility now, so the pipeline no
      // longer mkdirs ahead of the copy — it stats the source and hands the stats to stageSourceAudio.
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

      // #1598: managed-file cleanup (foreign-preserving, symlink-safe) replaces the blanket fs.rm.
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
        // mode omitted = pointer
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
      // Built with join() so they carry the same native separators reconstructDiscGroup emits
      // (join(parent, name) → backslashes on Windows). Forward-slash literals would mismatch the
      // reconstructed member paths on a Windows dev box while passing on Linux CI.
      const MEMBER_PATHS = [
        join('/audiobooks', 'Author - Book Disc 1 of 3'),
        join('/audiobooks', 'Author - Book Disc 2 of 3'),
        join('/audiobooks', 'Author - Book Disc 3 of 3'),
      ];

      /**
       * Mock the reconstruction filesystem: readdir('/audiobooks') lists `names`, and each named
       * subdir is audio-bearing (returns an audio file) unless listed in `audioless` (returns only
       * non-audio). reconstructDiscGroup now filters siblings to audio-bearing dirs before the
       * guard (#1280), so the per-sibling probe must be served, not just the parent listing.
       */
      async function mockSiblingTree(names: string[], audioless: string[] = []): Promise<void> {
        const fs = await import('node:fs/promises');
        vi.mocked(fs.readdir).mockImplementation(async (p: unknown) => {
          // reconstructDiscGroup probes siblings with join(parent, name) → backslashes on Windows;
          // normalize so the POSIX-keyed tree matches regardless of host separator.
          const key = String(p).split('\\').join('/');
          if (key === '/audiobooks') return names.map(n => makeDirent(n, false)) as never;
          const name = key.slice('/audiobooks/'.length);
          return (audioless.includes(name)
            ? [makeDirent('cover.jpg', true)]
            : [makeDirent('track.mp3', true)]) as never;
        });
      }

      /** The standard 3-disc audio-bearing sibling set used by the copy/move tests. */
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
        // 3 member-size reads then the aggregated target size — verification passes (300 vs 300)
        vi.mocked(getAudioPathSize)
          .mockResolvedValueOnce(100).mockResolvedValueOnce(100).mockResolvedValueOnce(100)
          .mockResolvedValueOnce(300);

        const payload: ManualImportJobPayload = {
          path: MEMBER_PATHS[0]!, title: 'Test Book', authorName: 'Author', mode: 'copy',
        };
        await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);

        expect(vi.mocked(copyDiscGroup)).toHaveBeenCalledWith(MEMBER_PATHS, TARGET_PATH, expect.any(Function));
        // Single-source copy must NOT run — the whole group is flattened, not just Disc 1
        expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();
        // AC2: verification sums every member size, then reads the target — not item.path alone.
        // The leading [TARGET_PATH] read is the #1287 pre-copy populated-target gate (here empty → 0).
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

        // #1598: each member is swept by the managed-file helper (foreign-preserving, symlink-safe).
        for (const member of MEMBER_PATHS) {
          expect(vi.mocked(deleteManagedBookFiles)).toHaveBeenCalledWith(
            member, expect.any(String), expect.anything(), { assertInsideLibrary: false },
          );
        }
        // AC2: move-mode runs the same full-member copy verification before the rm sweep —
        // every member size is read, then the target, not item.path alone.
        // The leading [TARGET_PATH] read is the #1287 pre-copy populated-target gate (here empty → 0).
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
          path: MEMBER_PATHS[0]!, title: 'Test Book', authorName: 'Author', // mode omitted = pointer
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

        // Discovery left this row ungrouped → import copies only its single folder
        expect(vi.mocked(copyDiscGroup)).not.toHaveBeenCalled();
        expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
          sourcePath: '/audiobooks/Author - Book Disc 1 of 10',
          targetPath: TARGET_PATH,
          onProgress: expect.any(Function),
        }));
      });

      it('pointer mode: AUDIO-bearing partial-marker sibling set is NOT rejected (discovery left it ungrouped)', async () => {
        // An audio-bearing markerless sibling is genuinely ambiguous → all-or-nothing guard refuses.
        await mockSiblingTree([
          'Author - Book Disc 1 of 3',
          'Author - Book Disc 2 of 3',
          'Author - Book Bonus Material',
        ]);
        const { copyDiscGroup } = await import('../../utils/import-helpers.js');

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Author - Book Disc 1 of 3', title: 'Test Book', authorName: 'Author', // pointer
        };
        await adapter.process(makeJob({ metadata: JSON.stringify(payload) }), ctx);

        // No multi-disc rejection, no flatten — ordinary pointer registration of the single folder
        const phases = setPhase.mock.calls.map((c: unknown[]) => c[0]);
        expect(phases).toContain('fetching_metadata');
        expect(vi.mocked(copyDiscGroup)).not.toHaveBeenCalled();
      });

      it('mode=copy: an AUDIOLESS stem-sharing sibling no longer drops discs — flattens ALL members (#1280)', async () => {
        // The data-loss case: previously an audioless `<stem> Artwork` sibling broke the import-side
        // all-or-nothing guard, silently copying only Disc 1. Now it is filtered out before the guard.
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

        // All 3 audio-bearing discs flattened (Artwork excluded), not just Disc 1
        expect(vi.mocked(copyDiscGroup)).toHaveBeenCalledWith(MEMBER_PATHS, TARGET_PATH, expect.any(Function));
        expect(vi.mocked(stageSourceAudio)).not.toHaveBeenCalled();

        // AC2: copy verification must sum EVERY reconstructed member's size, then read the target —
        // not silently fall back to checking only the anchor disc (item.path) against the target.
        // The exact call sequence proves all 3 member sizes are accumulated before the target read;
        // a regression to single-path verification would yield only [item.path, target] (2 calls).
        // The leading [TARGET_PATH] read is the #1287 pre-copy populated-target gate (here empty → 0).
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
      // Helper: pull the {path, size, ...} update from the shared setMock call log.
      // The adapter calls db.update(books).set(...) twice: once for path/size, once for status.
      // We filter by the presence of `path` to grab the persistence update.
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
        // Pointer mode: getAudioStats sees the file path directly, returns single-file stats.
        vi.mocked(getAudioStats).mockResolvedValueOnce({ fileCount: 1, totalSize: 12_345 });

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Doctor Sleep.m4b',
          title: 'Test Book',
          authorName: 'Author',
          // mode omitted = pointer
        };
        const job = makeJob({ metadata: JSON.stringify(payload) });

        await adapter.process(job, ctx);

        // getAudioStats was called with the source file path (no copy/rename phase)
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
        // After copy, getAudioStats is called against the target directory; size reflects copied file.
        vi.mocked(getAudioStats).mockResolvedValueOnce({ fileCount: 1, totalSize: 67_890 });

        const payload: ManualImportJobPayload = {
          path: '/audiobooks/Doctor Sleep.m4b',
          title: 'Test Book',
          authorName: 'Author',
          mode: 'copy',
        };
        const job = makeJob({ metadata: JSON.stringify(payload) });

        await adapter.process(job, ctx);

        // The source forwarded to the audio-only copier is the original file path. The copier itself
        // (import-steps copyToLibrary) handles the file-vs-directory branch — covered by its own suite.
        expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
          sourcePath: '/audiobooks/Doctor Sleep.m4b',
          targetPath: TARGET_PATH,
          sourceStats: expect.objectContaining({ isFile: expect.any(Function) }),
          onProgress: expect.any(Function),
        }));

        // After copy completes, books.path is the target directory and size is the
        // copied-file size returned by getAudioStats(targetPath).
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

        // #1598: move cleans the original source via the managed-file helper after copy verification.
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

      // mode='copy' → stageSourceAudio should run
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

        // 3 forward renames; stems collide on '{title}' → every file gets a padded
        // sequential ordinal incl. the first (#1192): 'Test Book (1/2/3)'.
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
        // Forward renames produce: a→Test Book (1), b→Test Book (2), c→Test Book (3).
        // Rollback after 3rd fails: reverses b→Test Book (2) and a→Test Book (1) (only the completed pair).
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

        // 3 forward + 2 rollback = 5 total
        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(5);
        const calls = vi.mocked(fs.rename).mock.calls;
        // Forward calls
        expect(calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book (1).mp3`]);
        expect(calls[1]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/b.mp3`, `${TARGET_PATH}/Test Book (2).mp3`]);
        expect(calls[2]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/c.mp3`, `${TARGET_PATH}/Test Book (3).mp3`]);
        // Rollback calls (reverse order, swapped from/to)
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
        // Regression guard (#1740): the rename runs BEFORE edition_label is persisted, so the
        // hydrated `getById` book still carries the stale/null label. The label that must drive the
        // rename is the one `copyToLibrary` returned on THIS import. We stub the pipeline copier
        // (the documented seam is otherwise real — see boundary note above) to return a non-empty
        // editionLabel while `getById` returns a DIFFERENT (null) value, proving precedence.
        const fs = await import('node:fs/promises');
        await mockReaddirAudioFiles(['a.mp3']);
        const copySpy = vi.spyOn(importOrchestration, 'copyToLibrary')
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
        copySpy.mockRestore();

        expect(vi.mocked(fs.rename)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fs.rename).mock.calls[0]!.map(normPath)).toEqual(
          [`${TARGET_PATH}/a.mp3`, `${TARGET_PATH}/Test Book (Full Cast).mp3`]);
      });

      it('mode=copy + fileFormat=\'{title} ({edition})\' + no copy-result label + getById returns editionLabel: falls back to the stored label (#1740)', async () => {
        // The undefined-passthrough branch: when no disambiguation occurred (copyToLibrary returns
        // no editionLabel), the rename still honors the hydrated/stored edition_label (#1712).
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
      // Should not throw — schema accepts the new fields incl. 0
      await adapter.process(job, ctx);
      expect(setPhase).toHaveBeenCalled();
    });

    it('worker rehydration: persisted seriesPosition: 0 reaches copyToLibrary target path via {seriesPosition} token (AC9/F2/#1028)', async () => {
      // Override settings so the folder format actually consumes seriesPosition — without
      // {seriesPosition} in the format, dropping toImportConfirmItem's conditional spread
      // for seriesPosition would not affect any observable downstream output. With this
      // format, a dropped seriesPosition makes the rendered path differ.
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

      // The expected target rendered from {author}/{series} #{seriesPosition}/{title}. seriesPosition: 0
      // must survive into the copier's target — a dropped conditional-spread would render a different path.
      const expectedTarget = '/library/Author/Discworld #0/Test Book';
      expect(vi.mocked(stageSourceAudio)).toHaveBeenCalledWith(expect.objectContaining({
        sourcePath: payload.path,
        targetPath: expectedTarget,
        onProgress: expect.any(Function),
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
});
