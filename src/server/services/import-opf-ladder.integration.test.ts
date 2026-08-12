import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

// Precedence spans the staged runner and adapter, so assert persisted rows after both execute.
// Only scanner, ffmpeg, and provider are mocked; OPF parsing through fill-empty writes is real.

vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/utils/audio-processor.js')>()),
  resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg'),
}));

import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, importJobs, importSubmissions, importSubmissionItems } from '@db/schema.js';
import { createMockLogger, createMockSettingsService, inject } from '../__tests__/helpers.js';
import { BookService } from './book.service.js';
import { BookImportService } from './book-import.service.js';
import { ImportSubmissionRunner } from './import-submission-runner.js';
import { ManualImportAdapter } from './import-adapters/manual.js';
import type { ImportAdapterContext, ImportJob } from './import-adapters/types.js';
import type { EventHistoryService } from './event-history.service.js';
import type { MetadataService } from './metadata.service.js';
import type { NotifierService } from './notifier.service.js';
import type { StagedImportItem } from '@core/import-staging/schemas.js';
import type { BookMetadata } from '@core/metadata/index.js';

interface DrainSeam { drainOne(): Promise<boolean> }

const OPF_NARRATOR = 'Opf Narrator';
const TAG_NARRATOR = 'Tag Narrator';
const PROVIDER_NARRATOR = 'Provider Narrator';

function curatedOpf(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    '    <meta name="narratorr:managed" content="true"/>',
    '    <dc:title>Opf Title</dc:title>',
    '    <dc:subtitle>Opf Subtitle</dc:subtitle>',
    '    <dc:creator opf:role="aut">Opf Author</dc:creator>',
    `    <dc:creator opf:role="nrt">${OPF_NARRATOR}</dc:creator>`,
    '    <dc:description>Opf Description</dc:description>',
    '    <dc:publisher>Opf Publisher</dc:publisher>',
    '    <dc:date>1999-09-09</dc:date>',
    '    <dc:subject>Opf Genre</dc:subject>',
    '    <meta name="calibre:series" content="Opf Series"/>',
    '    <meta name="calibre:series_index" content="4"/>',
    '  </metadata>',
    '</package>',
    '',
  ].join('\n');
}

const providerMatch = (overrides: Partial<BookMetadata> = {}): BookMetadata => ({
  title: 'Provider Title',
  authors: [{ name: 'Provider Author' }],
  narrators: [PROVIDER_NARRATOR],
  subtitle: 'Provider Subtitle',
  description: 'Provider Description',
  publisher: 'Provider Publisher',
  publishedDate: '2020-01-01',
  genres: ['Provider Genre'],
  ...overrides,
});

describe('OPF → tags → provider import ladder (#2158, DB-backed)', () => {
  let dir: string;
  let db: Db;
  let runner: ImportSubmissionRunner;
  let bookService: BookService;
  let adapter: ManualImportAdapter;
  let enrichBook: ReturnType<typeof vi.fn>;
  const log = createMockLogger();

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'opf-ladder-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);

    bookService = new BookService(db, inject(log));
    const bookImportService = new BookImportService(db, inject(log));
    runner = new ImportSubmissionRunner({
      db,
      log: inject(log),
      bookService,
      bookImportService,
      eventHistory: { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService,
      notifier: { notify: vi.fn().mockResolvedValue(undefined) } as unknown as NotifierService,
      nudgeImportWorker: vi.fn(),
    });

    enrichBook = vi.fn().mockResolvedValue(null);
    const metadataService = { enrichBook, resolveBook: vi.fn().mockResolvedValue(null) } as unknown as MetadataService;
    // Prevent the adapter from rewriting the OPF fixture mid-test.
    const settingsService = createMockSettingsService({ tagging: { writeOpf: false }, library: { fileFormat: '' } });
    adapter = new ManualImportAdapter({
      db,
      log: inject(log),
      bookService,
      bookImportService,
      settingsService,
      eventHistory: { create: vi.fn().mockResolvedValue(undefined) } as unknown as EventHistoryService,
      enrichmentDeps: { db, log: inject(log), settingsService, bookService, metadataService },
    });
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps libSQL handles open */ }
  });

  function seedFolder(name: string, opf?: string): string {
    const folder = join(dir, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'book.m4b'), '');
    if (opf) writeFileSync(join(folder, 'metadata.opf'), opf, 'utf-8');
    return folder;
  }

  function setTags(tagNarrator?: string): void {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'm4b', fileCount: 1,
      totalSize: 1000, totalDuration: 600, hasCoverArt: false,
      ...(tagNarrator !== undefined && { tagNarrator }),
    });
  }

  async function seedProcessing(item: StagedImportItem): Promise<number> {
    const [sub] = await db.insert(importSubmissions).values({
      clientSubmissionId: `c-${Math.random()}`,
      payloadDigest: 'a'.repeat(64), source: 'library', mode: null,
      expectedCount: 1, status: 'processing', receivedCount: 1,
    }).returning();
    await db.insert(importSubmissionItems).values({
      submissionId: sub!.id, ordinal: 0, itemPayload: item, path: item.path, title: item.title, disposition: 'pending',
    });
    return sub!.id;
  }

  async function drain(): Promise<void> {
    (runner as unknown as { running: boolean }).running = true;
    const seam = runner as unknown as DrainSeam;
    let guard = 0;
    while (await seam.drainOne()) {
      if (++guard > 100) throw new Error('drain did not converge');
    }
    (runner as unknown as { running: boolean }).running = false;
  }

  function adapterContext(): ImportAdapterContext {
    return {
      db, log: inject(log),
      setPhase: vi.fn().mockResolvedValue(undefined),
      emitProgress: vi.fn(),
    };
  }

  async function runLadder(item: StagedImportItem) {
    await seedProcessing(item);
    await drain();
    const [job] = await db.select().from(importJobs);
    expect(job).toBeDefined();
    await adapter.process(job as ImportJob, adapterContext());
    const [row] = await db.select().from(books).where(eq(books.id, job!.bookId!));
    const detail = await bookService.getById(job!.bookId!);
    return { job: job!, row: row!, detail: detail!, payload: JSON.parse(job!.metadata) as Record<string, unknown> };
  }

  const narratorNames = (detail: { narrators: { name: string }[] }): string[] => detail.narrators.map((n) => n.name);

  it('(a) OPF + tags + provider all disagreeing → every descriptive field comes from the OPF', async () => {
    const path = seedFolder('with-opf-', curatedOpf());
    setTags(TAG_NARRATOR);

    const { row, detail } = await runLadder({
      path, title: 'Folder Title', forceImport: true,
      narrators: [PROVIDER_NARRATOR], metadata: providerMatch(),
    });

    expect(narratorNames(detail)).toEqual([OPF_NARRATOR]);
    expect(row).toMatchObject({
      subtitle: 'Opf Subtitle',
      description: 'Opf Description',
      publisher: 'Opf Publisher',
      publishedDate: '1999-09-09',
    });
    expect(row.genres).toEqual(['Opf Genre']);
  });

  it('(b) tags + provider, no OPF, auto-matched row shape → the narrator comes from the TAGS', async () => {
    const path = seedFolder('no-opf-');
    setTags(TAG_NARRATOR);

    // Auto-matched rows carry top-level narrators deep-equal to metadata.narrators; this pins the tag gate.
    const { row, detail, payload } = await runLadder({
      path, title: 'Folder Title', forceImport: true,
      narrators: [PROVIDER_NARRATOR], metadata: providerMatch(),
    });

    expect(payload.narratorSource).toBe('provider');
    expect(narratorNames(detail)).toEqual([TAG_NARRATOR]);
    expect(row).toMatchObject({ subtitle: 'Provider Subtitle', description: 'Provider Description', publisher: 'Provider Publisher' });
  });

  it('(c) provider only → the provider narrator survives, byte-identical to the pre-#2158 outcome', async () => {
    const path = seedFolder('bare-');
    setTags(undefined);

    const { row, detail } = await runLadder({
      path, title: 'Folder Title', forceImport: true,
      narrators: [PROVIDER_NARRATOR], metadata: providerMatch(),
    });

    expect(narratorNames(detail)).toEqual([PROVIDER_NARRATOR]);
    expect(row).toMatchObject({ subtitle: 'Provider Subtitle', description: 'Provider Description' });
  });

  it('curated via OPF → the tag narrator is rejected', async () => {
    const path = seedFolder('curated-opf-', curatedOpf());
    setTags(TAG_NARRATOR);

    const { detail, payload } = await runLadder({ path, title: 'T', forceImport: true, metadata: providerMatch() });

    expect(payload.narratorSource).toBe('curated');
    expect(narratorNames(detail)).toEqual([OPF_NARRATOR]);
  });

  it('curated via a differing item.narrators (no OPF) → the tag narrator is rejected', async () => {
    const path = seedFolder('curated-wire-');
    setTags(TAG_NARRATOR);

    const { detail, payload } = await runLadder({
      path, title: 'T', forceImport: true,
      narrators: ['Hand Typed Narrator'], metadata: providerMatch(),
    });

    expect(payload.narratorSource).toBe('curated');
    expect(narratorNames(detail)).toEqual(['Hand Typed Narrator']);
  });

  it('none (no item.narrators, no OPF) → the tag narrator is accepted', async () => {
    const path = seedFolder('none-');
    setTags(TAG_NARRATOR);

    const { detail, payload } = await runLadder({
      path, title: 'T', forceImport: true,
      metadata: providerMatch({ narrators: [] }),
    });

    expect(payload.narratorSource).toBe('none');
    expect(narratorNames(detail)).toEqual([TAG_NARRATOR]);
  });

  it('OPF + provider-copied item.narrators → the OPF wins', async () => {
    // Auto-match already has top-level narrators; a metadata-only OPF overlay would be lost.
    const path = seedFolder('opf-vs-provider-', curatedOpf());
    setTags(TAG_NARRATOR);

    const { detail } = await runLadder({
      path, title: 'T', forceImport: true,
      narrators: [PROVIDER_NARRATOR], metadata: providerMatch(),
    });

    expect(narratorNames(detail)).toEqual([OPF_NARRATOR]);
  });

  it('OPF + a DIFFERING item.narrators → the OPF still wins (no fourth "user edit" tier)', async () => {
    const path = seedFolder('opf-vs-wire-', curatedOpf());
    setTags(TAG_NARRATOR);

    const { detail } = await runLadder({
      path, title: 'T', forceImport: true,
      narrators: ['Hand Typed Narrator'], metadata: providerMatch(),
    });

    expect(narratorNames(detail)).toEqual([OPF_NARRATOR]);
  });

  it('a CLEARED narrator field (narrators omitted, metadata retained) is refillable from tags', async () => {
    // The client omits cleared narrators, indistinguishable from never populated; durable clears use tombstones.
    const path = seedFolder('cleared-');
    setTags(TAG_NARRATOR);

    const { detail, payload } = await runLadder({
      path, title: 'T', forceImport: true, metadata: providerMatch(),
    });

    expect(payload.narratorSource).toBe('none');
    expect(narratorNames(detail)).toEqual([TAG_NARRATOR]);
  });

  it('AC9: the Audnexus pass leaves tag-supplied narrators in place', async () => {
    const path = seedFolder('audnexus-');
    setTags(TAG_NARRATOR);
    // A different provider narrator distinguishes a skipped write from an identical one.
    enrichBook.mockResolvedValue({ narrators: ['Audnexus Narrator'], asin: 'B00LADDER1' });

    const { detail } = await runLadder({
      path, title: 'T', forceImport: true, asin: 'B00LADDER1',
      metadata: providerMatch({ narrators: [] }),
    });

    expect(enrichBook).toHaveBeenCalled();
    expect(narratorNames(detail)).toEqual([TAG_NARRATOR]);
  });
});
