import { vi, type Mock } from 'vitest';
import { readdir, mkdir, cp, unlink, stat, rm, rename } from 'node:fs/promises';
import { processAudioFiles } from '@core/utils/audio-processor.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudioWithinAdmissionLock } from '../enrichment-utils.js';
import { dotPrefixBasename } from '@core/utils/hidden-staging.js';
import { createMockDbBook, createMockDbAuthor } from '../../__tests__/factories.js';
import { createMockDb, createMockLogger, createMockSettingsService, inject } from '../../__tests__/helpers.js';
import { MergeService } from '../merge.service.js';
import type { BookService } from '../book.service.js';
import type { EventBroadcasterService } from '../event-broadcaster.service.js';
import type { EventHistoryService } from '../event-history.service.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { MergeStateSnapshot } from '@shared/schemas/sse-events.js';

// Importing tests must declare their own `vi.mock` blocks; Vitest hoists mocks per file.

export const BOOK_PATH = '/library/Author/Title';
// Hidden staging prevents library scans from observing an incomplete merge.
export const STAGING_DIR = dotPrefixBasename(BOOK_PATH + '.merge-tmp');

export const mockAuthor = createMockDbAuthor();
export const mockBook = {
  ...createMockDbBook({
    id: 42,
    title: 'The Way of Kings',
    path: BOOK_PATH,
    status: 'imported',
  }),
  authors: [mockAuthor],
  narrators: [],
};

export const processingOverrides = {
  processing: {
    ffmpegPath: '/usr/bin/ffmpeg',
    outputFormat: 'm4b' as const,
    bitrate: 128,
    keepOriginalBitrate: false,
    maxConcurrentProcessing: 1,
    postProcessingScript: '',
    postProcessingScriptTimeout: 300,
  },
};

export const SCAN_RESULT = {
  codec: 'aac',
  bitrate: 128000,
  sampleRate: 44100,
  channels: 2,
  bitrateMode: 'cbr' as const,
  fileFormat: 'm4b',
  fileCount: 1,
  totalSize: 500_000_000,
  totalDuration: 36000,
  hasCoverArt: false,
};

export const settle = () => new Promise((r) => setTimeout(r, 50));

/** Externally settled promise: the parking primitive for holding the real admission lock. */
export function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function setupHappyPath() {
  (readdir as Mock).mockImplementation(async (dir: string) => {
    if (dir.endsWith('.merge-tmp')) return ['The Way of Kings.m4b'];
    return ['01.mp3', '02.mp3', 'cover.jpg'];
  });
  (mkdir as Mock).mockResolvedValue(undefined);
  (cp as Mock).mockResolvedValue(undefined);
  (processAudioFiles as Mock).mockResolvedValue({ success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] });
  (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
  (rename as Mock).mockResolvedValue(undefined);
  (unlink as Mock).mockResolvedValue(undefined);
  (rm as Mock).mockResolvedValue(undefined);
  (stat as Mock).mockResolvedValue({ size: 500_000_000 });
  (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
}

export function setupBlockingMerge() {
  (readdir as Mock).mockImplementation(async (dir: string) => (dir.endsWith('.merge-tmp') ? ['out.m4b'] : ['01.mp3', '02.mp3']));
  (mkdir as Mock).mockResolvedValue(undefined);
  (cp as Mock).mockResolvedValue(undefined);
  (rm as Mock).mockResolvedValue(undefined);
  (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
  (rename as Mock).mockResolvedValue(undefined);
  (unlink as Mock).mockResolvedValue(undefined);
  (stat as Mock).mockResolvedValue({ size: 100 });
  (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  (processAudioFiles as Mock).mockImplementation(async () => {
    await blocked;
    return { success: true, outputFiles: ['/staging/out.m4b'] };
  });
  return { release };
}

export type MergeHarnessBook = { id: number; title: string; path?: string | undefined };
export type MergeHarnessFrame = { event: string; payload: Record<string, unknown> };
export type MergeHarnessHistoryRow = { bookId: number; eventType: string; source: string; reason?: { error: string } };

function mergeHarnessRow(book: MergeHarnessBook) {
  return {
    ...createMockDbBook({ id: book.id, title: book.title, path: book.path ?? `/lib/${book.id}`, status: 'imported' }),
    authors: [mockAuthor],
    narrators: [],
  };
}

export type MergeHarnessRow = ReturnType<typeof mergeHarnessRow>;

/** `| undefined` on every key so callers can spread a conditional override under exactOptionalPropertyTypes. */
export type MergeHarnessOptions = {
  books?: MergeHarnessBook[] | undefined;
  /** Omitted leaves `processingOverrides`' value of 1 in place — never `undefined`. */
  maxConcurrentProcessing?: number | undefined;
  /** `absent` constructs the service with no broadcaster: safeEmit no-ops and no frame is ever recorded. */
  broadcaster?: 'recording' | 'absent' | undefined;
};

/** Concrete shape so a missing accessor fails typecheck rather than one runtime assertion (#2540 F1). */
export type MergeHarness = {
  service: MergeService;
  db: ReturnType<typeof createMockDb>;
  bookService: { getById: Mock<(id: number) => Promise<MergeHarnessRow | null>>; update: Mock };
  create: Mock;
  frames: MergeHarnessFrame[];
  /** State as observed DURING each terminal emit; the final snapshot alone cannot prove delete-before-emit ordering. */
  stateAtTerminal: Map<number, MergeStateSnapshot>;
  rowFor: (id: number) => MergeHarnessRow;
  framesOf: (event: string, bookId: number) => MergeHarnessFrame[];
  framesAfter: (event: string, bookId: number) => MergeHarnessFrame[];
  snapshots: () => MergeStateSnapshot[];
  events: () => string[];
  historyOf: (bookId: number, eventType: string) => MergeHarnessHistoryRow[];
};

export function createMergeHarness(opts?: MergeHarnessOptions): MergeHarness {
  const byId = new Map((opts?.books ?? [{ id: 42, title: 'Dogs of War' }]).map((b) => [b.id, mergeHarnessRow(b)]));

  const frames: MergeHarnessFrame[] = [];
  const stateAtTerminal = new Map<number, MergeStateSnapshot>();
  // The service does not exist until the broadcaster is already built, so the emit hook reaches it late.
  const holder: { service?: MergeService } = {};
  const eventBroadcaster = opts?.broadcaster === 'absent' ? undefined : inject<EventBroadcasterService>({
    emit: vi.fn((event: string, payload: Record<string, unknown>) => {
      frames.push({ event, payload });
      if (event === 'merge_complete' || event === 'merge_failed') {
        stateAtTerminal.set(payload.book_id as number, holder.service!.getMergeStateSnapshot());
      }
    }),
  });

  const historyRows: MergeHarnessHistoryRow[] = [];
  const create = vi.fn(async (row: MergeHarnessHistoryRow) => { historyRows.push(row); });
  const bookService = {
    getById: vi.fn(async (id: number) => byId.get(id) ?? null),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const db = createMockDb();

  const service = new MergeService(
    inject<Db>(db),
    inject<BookService>(bookService),
    createMockSettingsService({
      processing: {
        ...processingOverrides.processing,
        ...(opts?.maxConcurrentProcessing !== undefined && { maxConcurrentProcessing: opts.maxConcurrentProcessing }),
      },
    }),
    inject<FastifyBaseLogger>(createMockLogger()),
    inject<EventHistoryService>({ create }),
    eventBroadcaster,
  );
  holder.service = service;

  return {
    service, db, bookService, create, frames, stateAtTerminal,
    rowFor: (id) => byId.get(id)!,
    framesOf: (event, bookId) => frames.filter((f) => f.event === event && f.payload.book_id === bookId),
    framesAfter: (event, bookId) =>
      frames.slice(frames.findIndex((f) => f.event === event && f.payload.book_id === bookId) + 1),
    snapshots: () => frames.filter((f) => f.event === 'merge_state').map((f) => f.payload as MergeStateSnapshot),
    events: () => frames.map((f) => f.event),
    historyOf: (bookId, eventType) => historyRows.filter((r) => r.bookId === bookId && r.eventType === eventType),
  };
}
