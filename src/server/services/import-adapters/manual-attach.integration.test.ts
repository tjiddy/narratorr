import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

// Only the audio scanner, ffmpeg lookup and metadata provider are doubled; naming, copying,
// enrichment guards and every persisted row are real, because the ACs are about what LANDED.
vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/utils/audio-processor.js')>()),
  resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg'),
}));
// Extend, don't replace: `isRemoteCoverUrl` must stay real or the suppression under test is faked.
vi.mock('../cover-download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cover-download.js')>()),
  downloadRemoteCoverWithinAdmissionLock: vi.fn().mockResolvedValue('written'),
}));

import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { downloadRemoteCoverWithinAdmissionLock } from '../cover-download.js';
import { runCoverBackfill } from '../../jobs/cover-backfill.js';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { bookEvents, books, importJobs, importSubmissionItems, importSubmissions } from '@db/schema.js';
import { createMockLogger, createMockSettingsService, inject } from '../../__tests__/helpers.js';
import { BookService } from '../book.service.js';
import { BookImportService } from '../book-import.service.js';
import { ImportSubmissionRunner } from '../import-submission-runner.js';
import { ManualImportAdapter } from './manual.js';
import type { ImportAdapterContext, ImportJob } from './types.js';
import type { MetadataService } from '../metadata.service.js';
import type { NotifierService } from '../notifier.service.js';
import type { SettingsService } from '../settings.service.js';
import type { StagedImportItem } from '@core/import-staging/schemas.js';
import { EventHistoryService } from '../event-history.service.js';
import type { BlacklistService } from '../blacklist.service.js';

interface DrainSeam { drainOne(): Promise<boolean> }

const posix = (p: string): string => p.split('\\').join('/');

describe('ManualImportAdapter attach path (DB-backed, #2435)', () => {
  let dir: string;
  let libraryRoot: string;
  let db: Db;
  let bookService: BookService;
  let bookImportService: BookImportService;
  let adapter: ManualImportAdapter;
  let runner: ImportSubmissionRunner;
  let enrichBook: ReturnType<typeof vi.fn>;
  let eventHistory: EventHistoryService;
  const log = createMockLogger();

  function buildAdapter(settingsService: SettingsService): ManualImportAdapter {
    const metadataService = { enrichBook, resolveBook: vi.fn().mockResolvedValue(null) } as unknown as MetadataService;
    return new ManualImportAdapter({
      db,
      log: inject(log),
      bookService,
      bookImportService,
      settingsService,
      eventHistory,
      enrichmentDeps: { db, log: inject(log), settingsService, bookService, metadataService },
    });
  }

  /** Rebuild the adapter with different library settings (naming templates differ per case). */
  function withSettings(library: Record<string, unknown> = {}): void {
    adapter = buildAdapter(createMockSettingsService({
      tagging: { writeOpf: false },
      library: { path: libraryRoot, folderFormat: '{author}/{title}', fileFormat: '', ...library },
    }));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'attach-'));
    libraryRoot = join(dir, 'library');
    mkdirSync(libraryRoot, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);

    bookService = new BookService(db, inject(log));
    bookImportService = new BookImportService(db, inject(log));
    eventHistory = new EventHistoryService(db, inject(log), inject<BlacklistService>({}), bookService);
    enrichBook = vi.fn().mockResolvedValue(null);
    setTags();
    withSettings();

    runner = new ImportSubmissionRunner({
      db,
      log: inject(log),
      bookService,
      bookImportService,
      eventHistory,
      notifier: { notify: vi.fn().mockResolvedValue(undefined) } as unknown as NotifierService,
      nudgeImportWorker: vi.fn(),
    });
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps libSQL handles open */ }
  });

  function setTags(overrides: Record<string, unknown> = {}): void {
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2,
      bitrateMode: 'cbr' as const, fileFormat: 'm4b', fileCount: 1,
      totalSize: 4096, totalDuration: 3600, hasCoverArt: false,
      ...overrides,
    } as never);
  }

  function seedSource(name: string, opf?: string): string {
    const folder = join(dir, 'staging', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'book.m4b'), Buffer.alloc(4096, 7));
    if (opf) writeFileSync(join(folder, 'metadata.opf'), opf, 'utf-8');
    return folder;
  }

  /** A fileless incumbent, with author/narrator relations where the case needs them. */
  async function seedIncumbent(overrides: {
    book?: Record<string, unknown>;
    authorName?: string;
    narrators?: string[];
  } = {}): Promise<number> {
    const created = await bookService.create({
      title: 'Incumbent Title',
      status: 'importing',
      ...(overrides.authorName ? { authors: [{ name: overrides.authorName }] } : {}),
      ...(overrides.narrators ? { narrators: overrides.narrators } : {}),
      ...(overrides.book ?? {}),
    } as never);
    // `create` normalizes some lifecycle fields; write the raw row state the case needs.
    await db.update(books).set({ path: null, ...(overrides.book ?? {}), status: 'importing' }).where(eq(books.id, created.id));
    return created.id;
  }

  async function enqueueAttach(bookId: number, sourcePath: string, mode: 'copy' | 'move' = 'copy'): Promise<ImportJob> {
    const result = await bookImportService.enqueue({
      bookId, type: 'manual',
      metadata: JSON.stringify({ path: sourcePath, title: 'Offered Title', mode, attach: true }),
    });
    if ('error' in result) throw new Error('enqueue failed');
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, result.jobId));
    return job as ImportJob;
  }

  function adapterContext(): ImportAdapterContext {
    return { db, log: inject(log), setPhase: vi.fn().mockResolvedValue(undefined), emitProgress: vi.fn() };
  }

  const rowOf = async (id: number) => (await db.select().from(books).where(eq(books.id, id)))[0]!;

  // ── AC7/AC18: the attach completes against the existing book ───────────────────────────────────

  it('places the file, records it on the incumbent and flips it to imported', async () => {
    const bookId = await seedIncumbent({ authorName: 'Real Author', book: { title: 'Real Title' } });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    const row = await rowOf(bookId);
    expect(row.status).toBe('imported');
    expect(posix(row.path!)).toContain(posix(libraryRoot));
    expect(row.size).toBeGreaterThan(0);
    // No second book: the attach fulfils the record that already existed.
    expect(await db.select().from(books)).toHaveLength(1);
  });

  // ── AC23: naming comes from the incumbent, on every token ─────────────────────────────────────

  it('renders EVERY naming token from the incumbent, not the offered payload', async () => {
    withSettings({ folderFormat: '{author}/{narrator}/{year}/{title} ({edition})' });
    const bookId = await seedIncumbent({
      authorName: 'Incumbent Author',
      narrators: ['Incumbent Narrator'],
      book: { title: 'Incumbent Title', publishedDate: '1999-09-09', editionLabel: 'Full Cast' },
    });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    const path = posix((await rowOf(bookId)).path!);
    expect(path).toContain('Incumbent Author');
    expect(path).toContain('Incumbent Narrator');
    expect(path).toContain('1999');
    expect(path).toContain('Incumbent Title');
    // The stored label seeds the BASE target, so the folder and a {edition} token agree.
    expect(path).toContain('Full Cast');
    expect(path).not.toContain('Offered Title');
  });

  it('renders no year at all for a dateless incumbent — never the source\'s (AC25)', async () => {
    withSettings({ folderFormat: '{author}/{year}/{title}' });
    const bookId = await seedIncumbent({ authorName: 'Solo Author', book: { title: 'No Date', publishedDate: null } });
    const source = seedSource('offered');
    // The offered side supplies a year; filling from it is the substitution AC24 forbids.
    const result = await bookImportService.enqueue({
      bookId, type: 'manual',
      metadata: JSON.stringify({
        path: source, title: 'Offered', mode: 'copy', attach: true,
        metadata: { title: 'Offered', authors: [{ name: 'Offered Author' }], publishedDate: '2011-11-11' },
      }),
    });
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, (result as { jobId: number }).jobId));

    await adapter.process(job as ImportJob, adapterContext());

    // `renderTemplate` drops a segment that resolves to empty, so the honest outcome is an absent
    // year rather than a placeholder — either way it never falls back to request data.
    const path = posix((await rowOf(bookId)).path!);
    expect(path).toContain('Solo Author/No Date');
    expect(path).not.toContain('2011');
  });

  it('renders the incumbent year when it has one, alongside a conflicting offered year (AC25)', async () => {
    withSettings({ folderFormat: '{author}/{year}/{title}' });
    const bookId = await seedIncumbent({
      authorName: 'Dated Author', book: { title: 'Dated', publishedDate: '1999-09-09' },
    });
    const source = seedSource('offered');
    const result = await bookImportService.enqueue({
      bookId, type: 'manual',
      metadata: JSON.stringify({
        path: source, title: 'Offered', mode: 'copy', attach: true,
        metadata: { title: 'Offered', authors: [{ name: 'Offered Author' }], publishedDate: '2011-11-11' },
      }),
    });
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, (result as { jobId: number }).jobId));

    await adapter.process(job as ImportJob, adapterContext());

    const path = posix((await rowOf(bookId)).path!);
    expect(path).toContain('Dated Author/1999/Dated');
    expect(path).not.toContain('2011');
  });

  it('derives the keep-both edition label from the incumbent production type (AC23)', async () => {
    withSettings({ folderFormat: '{author}/{title} ({edition})' });
    const bookId = await seedIncumbent({
      authorName: 'Collide Author',
      book: { title: 'Collide Title', productionType: 'full_cast' },
    });
    // Occupy the base target with audio owned by nobody, forcing disambiguation.
    const occupied = join(libraryRoot, 'Collide Author', 'Collide Title');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'other.m4b'), Buffer.alloc(2048, 3));
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    // The label comes from the incumbent's production type, not the offer's — and it is not a
    // `recording-review-no-disambiguator` failure.
    const path = posix((await rowOf(bookId)).path!);
    expect(path).toContain('Full Cast');
  });

  // ── AC28: enrichment may fill an empty field but never replace a populated one ─────────────────

  it('does not let audio tags replace a populated incumbent narrator list or duration', async () => {
    const bookId = await seedIncumbent({
      authorName: 'A', narrators: ['Curated Narrator'], book: { title: 'T', duration: 600 },
    });
    setTags({ tagNarrator: 'Tag Narrator', totalDuration: 7200 });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    // Asserted separately: distinct code paths, gated on distinct values.
    const detail = await bookService.getById(bookId);
    expect(detail!.narrators.map((n) => n.name)).toEqual(['Curated Narrator']);
    expect((await rowOf(bookId)).duration).toBe(600);
  });

  it('still fills genuinely empty incumbent narrators and duration from the audio', async () => {
    const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T', duration: null } });
    setTags({ tagNarrator: 'Tag Narrator', totalDuration: 7200 });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    const detail = await bookService.getById(bookId);
    expect(detail!.narrators.map((n) => n.name)).toEqual(['Tag Narrator']);
    expect((await rowOf(bookId)).duration).toBe(120); // 7200s / 60
  });

  it('always updates the technical audio statistics, populated incumbent or not', async () => {
    const bookId = await seedIncumbent({
      authorName: 'A', narrators: ['Curated'], book: { title: 'T', duration: 600 },
    });
    setTags({ tagNarrator: 'Tag Narrator', totalDuration: 7200 });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    const row = await rowOf(bookId);
    // These describe the file just placed, not the bibliography — the point of the attach.
    expect(row.audioCodec).toBe('aac');
    expect(row.audioBitrate).toBe(64000);
    expect(row.audioFileCount).toBe(1);
    expect(row.audioTotalSize).toBe(4096);
    expect(row.audioDuration).toBe(7200);
  });

  it('fills narrators on incumbent emptiness alone — provenance is not consulted', async () => {
    const bookId = await seedIncumbent({ authorName: 'A', narrators: ['Curated'], book: { title: 'T' } });
    setTags({ tagNarrator: 'Tag Narrator' });
    const source = seedSource('offered');
    // `narratorSource: 'provider'` is the value `tagNarratorFillAllowed` would act on today.
    const result = await bookImportService.enqueue({
      bookId, type: 'manual',
      metadata: JSON.stringify({ path: source, title: 'Offered', mode: 'copy', attach: true, narratorSource: 'provider' }),
    });
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, (result as { jobId: number }).jobId));

    await adapter.process(job as ImportJob, adapterContext());

    const detail = await bookService.getById(bookId);
    expect(detail!.narrators.map((n) => n.name)).toEqual(['Curated']);
  });

  // ── AC28: no cover acquisition ────────────────────────────────────────────────────────────────

  it('extracts NO embedded art onto a coverless incumbent (AC28)', async () => {
    // coverUrl null is the case a non-attach import WOULD write: it is the positive control's
    // mirror, and the only fixture that can distinguish suppression from an incidental no-op.
    const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T', coverUrl: null } });
    setTags({ coverImage: Buffer.from('EMBEDDEDART'), coverMimeType: 'image/jpeg' });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    const row = await rowOf(bookId);
    expect(row.coverUrl).toBeNull();
    expect(readdirSync(row.path!).filter((f) => f.startsWith('cover.'))).toEqual([]);
  });

  it('attempts no outbound cover download and leaves an https coverUrl byte-identical (AC28)', async () => {
    const bookId = await seedIncumbent({
      authorName: 'A', book: { title: 'T', coverUrl: 'https://example.com/c.jpg' },
    });
    setTags({ coverImage: Buffer.from('EMBEDDEDART'), coverMimeType: 'image/jpeg' });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    const row = await rowOf(bookId);
    expect(row.coverUrl).toBe('https://example.com/c.jpg');
    expect(readdirSync(row.path!).filter((f) => f.startsWith('cover.'))).toEqual([]);
    expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
  });

  it('retains an http:// incumbent cover unchanged — no localization, no rewrite (AC28)', async () => {
    const bookId = await seedIncumbent({
      authorName: 'A', book: { title: 'T', coverUrl: 'http://example.com/c.jpg' },
    });
    setTags({ coverImage: Buffer.from('EMBEDDEDART'), coverMimeType: 'image/jpeg' });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    expect((await rowOf(bookId)).coverUrl).toBe('http://example.com/c.jpg');
    expect(downloadRemoteCoverWithinAdmissionLock).not.toHaveBeenCalled();
  });

  it('does not overwrite cover bytes already sitting at the canonical filename (AC28)', async () => {
    const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T', coverUrl: null } });
    setTags({ coverImage: Buffer.from('EMBEDDEDART'), coverMimeType: 'image/jpeg' });
    const target = join(libraryRoot, 'A', 'T');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'cover.jpg'), 'OPERATOR-UPLOAD');
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    // Byte-level: path existence alone cannot tell "left alone" from "overwritten same-filename".
    expect(readFileSync(join(target, 'cover.jpg'), 'utf-8')).toBe('OPERATOR-UPLOAD');
  });

  it('leaves the attached book a valid cover-backfill candidate (AC28, eligibility not scheduling)', async () => {
    const bookId = await seedIncumbent({
      authorName: 'A', book: { title: 'T', coverUrl: 'http://example.com/c.jpg' },
    });
    const source = seedSource('offered');
    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    // Invoked directly: no production handoff is scheduled, so asserting one would be a fiction.
    await runCoverBackfill(db, inject(log));

    expect(downloadRemoteCoverWithinAdmissionLock).toHaveBeenCalledWith(
      bookId, expect.any(String), 'http://example.com/c.jpg', db, expect.anything(),
    );
  });

  // ── AC28: provider identity and the second duration write ─────────────────────────────────────

  it('queries the provider with the incumbent identity and no offered alternate ASINs', async () => {
    const bookId = await seedIncumbent({
      authorName: 'Incumbent Author', book: { title: 'Incumbent Title', asin: 'B0INCUMB01' },
    });
    const source = seedSource('offered');
    const result = await bookImportService.enqueue({
      bookId, type: 'manual',
      metadata: JSON.stringify({
        path: source, title: 'Offered Title', authorName: 'Offered Author', mode: 'copy', attach: true,
        asin: 'B0OFFERED1',
        metadata: { title: 'Offered Title', authors: [{ name: 'Offered Author' }], alternateAsins: ['B0ALT00001'] },
      }),
    });
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, (result as { jobId: number }).jobId));

    await adapter.process(job as ImportJob, adapterContext());

    // Assert on the captured REQUEST: a result-only assertion passes whenever the wrong lookup
    // happens to return nothing.
    const queried = enrichBook.mock.calls.map((c) => c[0]);
    expect(queried).toContain('B0INCUMB01');
    expect(queried).not.toContain('B0OFFERED1');
    expect(queried).not.toContain('B0ALT00001');
  });

  it('does not let the provider replace a populated incumbent duration', async () => {
    const bookId = await seedIncumbent({
      authorName: 'A', book: { title: 'T', asin: 'B0INCUMB02', duration: 600 },
    });
    enrichBook.mockResolvedValue({ title: 'T', authors: [{ name: 'A' }], duration: 500 });
    setTags({ totalDuration: 0 });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    expect((await rowOf(bookId)).duration).toBe(600);
  });

  it('lets the provider duration land when the incumbent genuinely has none', async () => {
    const bookId = await seedIncumbent({
      authorName: 'A', book: { title: 'T', asin: 'B0INCUMB03', duration: null },
    });
    enrichBook.mockResolvedValue({ title: 'T', authors: [{ name: 'A' }], duration: 500 });
    setTags({ totalDuration: 0 });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    expect((await rowOf(bookId)).duration).toBe(500);
  });

  // ── AC28: an operator edit landing mid-import is not overwritten ──────────────────────────────

  /**
   * The difference between "never replaces a populated field" and "never replaces a field that was
   * populated several minutes ago". Hydration happens before the copy; the copy and audio scan can
   * run for minutes; `PUT /api/books/:id` has no status guard. A snapshot-based implementation
   * passes every other AC28 case and fails only here.
   *
   * Synchronised on a real seam — the operator's write commits inside the scanner / provider double,
   * before the enrichment write it races — never on a timer.
   */
  describe('an operator edit landing mid-import survives', () => {
    it('duration, written through the AUDIO path', async () => {
      const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T', duration: null } });
      vi.mocked(scanAudioDirectory).mockImplementation(async () => {
        await db.update(books).set({ duration: 999 }).where(eq(books.id, bookId));
        return { codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
          fileFormat: 'm4b', fileCount: 1, totalSize: 4096, totalDuration: 7200, hasCoverArt: false } as never;
      });
      const source = seedSource('offered');

      await adapter.process(await enqueueAttach(bookId, source), adapterContext());

      expect((await rowOf(bookId)).duration).toBe(999);
    });

    it('narrators, written through the AUDIO path', async () => {
      const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T' } });
      vi.mocked(scanAudioDirectory).mockImplementation(async () => {
        await bookService.update(bookId, { narrators: ['Operator Narrator'] });
        return { codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
          fileFormat: 'm4b', fileCount: 1, totalSize: 4096, totalDuration: 3600, hasCoverArt: false,
          tagNarrator: 'Tag Narrator' } as never;
      });
      const source = seedSource('offered');

      await adapter.process(await enqueueAttach(bookId, source), adapterContext());

      const detail = await bookService.getById(bookId);
      expect(detail!.narrators.map((n) => n.name)).toEqual(['Operator Narrator']);
    });

    it.each([
      ['duration', { duration: 999 }, { duration: 500 }, (r: Record<string, unknown>) => r.duration, 999],
      ['subtitle', { subtitle: 'Operator Subtitle' }, { subtitle: 'Provider Subtitle' }, (r: Record<string, unknown>) => r.subtitle, 'Operator Subtitle'],
      ['publisher', { publisher: 'Operator Publisher' }, { publisher: 'Provider Publisher' }, (r: Record<string, unknown>) => r.publisher, 'Operator Publisher'],
    ])('%s, written through the PROVIDER path', async (_field, operatorWrite, providerData, read, expected) => {
      const bookId = await seedIncumbent({
        authorName: 'A', book: { title: 'T', asin: 'B0RACE00001', duration: null, subtitle: null, publisher: null },
      });
      setTags({ totalDuration: 0 });
      enrichBook.mockImplementation(async () => {
        await db.update(books).set(operatorWrite).where(eq(books.id, bookId));
        return { title: 'T', authors: [{ name: 'A' }], ...providerData };
      });
      const source = seedSource('offered');

      await adapter.process(await enqueueAttach(bookId, source), adapterContext());

      expect(read((await rowOf(bookId)) as unknown as Record<string, unknown>)).toBe(expected);
    });

    it('genres, written through the PROVIDER path', async () => {
      const bookId = await seedIncumbent({
        authorName: 'A', book: { title: 'T', asin: 'B0RACE00002', genres: null },
      });
      setTags({ totalDuration: 0 });
      enrichBook.mockImplementation(async () => {
        await db.update(books).set({ genres: ['Operator Genre'] }).where(eq(books.id, bookId));
        return { title: 'T', authors: [{ name: 'A' }], genres: ['Provider Genre'] };
      });
      const source = seedSource('offered');

      await adapter.process(await enqueueAttach(bookId, source), adapterContext());

      expect((await rowOf(bookId)).genres).toEqual(['Operator Genre']);
    });
  });

  // ── AC29: history names the incumbent ─────────────────────────────────────────────────────────

  it('records the imported event against the incumbent title and author', async () => {
    const bookId = await seedIncumbent({
      authorName: 'Incumbent Author', narrators: ['Incumbent Narrator'], book: { title: 'Incumbent Title' },
    });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    // Read the PERSISTED row: the durable artifact is what the activity history renders.
    const [event] = await db.select().from(bookEvents).where(eq(bookEvents.bookId, bookId));
    expect(event).toMatchObject({
      eventType: 'imported', source: 'manual',
      bookTitle: 'Incumbent Title', authorName: 'Incumbent Author', narratorName: 'Incumbent Narrator',
    });
  });

  it('names the incumbent on a post-hydration failure too, with the real bookId', async () => {
    const bookId = await seedIncumbent({ authorName: 'Incumbent Author', book: { title: 'Incumbent Title' } });
    const source = seedSource('offered');
    const job = await enqueueAttach(bookId, source);
    // Fail after hydration: the target folder is occupied by an unownable different recording.
    vi.mocked(scanAudioDirectory).mockRejectedValue(new Error('scan exploded'));
    vi.spyOn(bookService, 'findPathOwners').mockRejectedValue(new Error('copy exploded'));
    mkdirSync(join(libraryRoot, 'Incumbent Author', 'Incumbent Title'), { recursive: true });
    writeFileSync(join(libraryRoot, 'Incumbent Author', 'Incumbent Title', 'x.m4b'), Buffer.alloc(1024));

    await expect(adapter.process(job, adapterContext())).rejects.toThrow();

    const [event] = await db.select().from(bookEvents).where(eq(bookEvents.bookId, bookId));
    expect(event).toMatchObject({ eventType: 'import_failed', bookTitle: 'Incumbent Title', authorName: 'Incumbent Author', bookId });
  });

  // ── AC27: hydration point, deleted rows, and the non-attach fence ──────────────────────────────

  it('hydrates for the naming override itself, not via the rename path (blank fileFormat)', async () => {
    // With a blank fileFormat `renameIfConfigured` returns early and never calls getById, so a
    // hydration bolted onto that call site would render the OFFERED name here.
    withSettings({ folderFormat: '{author}/{title}', fileFormat: '' });
    const bookId = await seedIncumbent({ authorName: 'Hydrate Author', book: { title: 'Hydrate Title' } });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    const path = posix((await rowOf(bookId)).path!);
    expect(path).toContain('Hydrate Author/Hydrate Title');
    expect(path).not.toContain('Offered Title');
  });

  it('fails the job and writes NOTHING when the book was deleted between enqueue and processing', async () => {
    const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T' } });
    const source = seedSource('offered');
    const job = await enqueueAttach(bookId, source);
    const eventsBefore = (await db.select().from(bookEvents)).length;
    await db.delete(books).where(eq(books.id, bookId));

    await expect(adapter.process(job, adapterContext())).rejects.toThrow(/not found/);

    // Count rows rather than inspect a spy: recordImportFailedEvent swallows a rejected insert, so
    // a spy cannot tell "never attempted" from "attempted and silently failed".
    expect((await db.select().from(bookEvents)).length).toBe(eventsBefore);
    expect(existsSync(join(libraryRoot, 'A'))).toBe(false);
  });

  it('leaves an ordinary non-attach manual import unchanged', async () => {
    const created = await bookService.create({ title: 'New Book', status: 'importing', authors: [{ name: 'New Author' }] } as never);
    const getById = vi.spyOn(bookService, 'getById');
    const source = seedSource('offered');
    const result = await bookImportService.enqueue({
      bookId: created.id, type: 'manual',
      metadata: JSON.stringify({ path: source, title: 'Payload Title', authorName: 'Payload Author', mode: 'copy' }),
    });
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, (result as { jobId: number }).jobId));

    await adapter.process(job as ImportJob, adapterContext());

    // No hydration read, and the target renders from the payload exactly as today.
    expect(getById).not.toHaveBeenCalled();
    expect(posix((await rowOf(created.id)).path!)).toContain('Payload Author/Payload Title');
  });

  it('commits books.path after the copy and before enrichment (ordering)', async () => {
    const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T' } });
    let pathAtEnrichment: string | null = null;
    vi.mocked(scanAudioDirectory).mockImplementation(async () => {
      // A crash between the copy and enrichment must not leave files placed with a null path.
      pathAtEnrichment = (await rowOf(bookId)).path;
      return { codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
        fileFormat: 'm4b', fileCount: 1, totalSize: 4096, totalDuration: 3600, hasCoverArt: false } as never;
    });
    const source = seedSource('offered');

    await adapter.process(await enqueueAttach(bookId, source), adapterContext());

    expect(pathAtEnrichment).not.toBeNull();
    expect(posix(pathAtEnrichment!)).toContain(posix(libraryRoot));
  });

  it('still reaches the occupied-target fence, leaving the incumbent un-stranded', async () => {
    const bookId = await seedIncumbent({ authorName: 'A', book: { title: 'T' } });
    // Two owners of the computed target is ambiguous ownership, which never permits a swap.
    const target = join(libraryRoot, 'A', 'T');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'other.m4b'), Buffer.alloc(2048, 3));
    const other1 = await bookService.create({ title: 'Other1', status: 'imported', authors: [{ name: 'Z' }] } as never);
    const other2 = await bookService.create({ title: 'Other2', status: 'imported', authors: [{ name: 'Z' }] } as never);
    await db.update(books).set({ path: target }).where(eq(books.id, other1.id));
    await db.update(books).set({ path: target }).where(eq(books.id, other2.id));
    const source = seedSource('offered');

    await expect(adapter.process(await enqueueAttach(bookId, source), adapterContext())).rejects.toThrow();

    // The fence refused before any write; the incumbent keeps the status its enqueue set.
    const row = await rowOf(bookId);
    expect(row.path).toBeNull();
    expect(row.status).toBe('importing');
  });

  // ── AC5 + AC24: the staged runner end to end ──────────────────────────────────────────────────

  describe('through the staged runner', () => {
    async function stage(item: StagedImportItem): Promise<ImportJob> {
      const [sub] = await db.insert(importSubmissions).values({
        clientSubmissionId: `c-${Math.random()}`, payloadDigest: 'a'.repeat(64),
        source: 'manual', mode: 'copy', expectedCount: 1, status: 'processing', receivedCount: 1,
      }).returning();
      await db.insert(importSubmissionItems).values({
        submissionId: sub!.id, ordinal: 0, itemPayload: item, path: item.path, title: item.title, disposition: 'pending',
      });
      (runner as unknown as { running: boolean }).running = true;
      const seam = runner as unknown as DrainSeam;
      let guard = 0;
      while (await seam.drainOne()) {
        if (++guard > 100) throw new Error('drain did not converge');
      }
      (runner as unknown as { running: boolean }).running = false;
      const [job] = await db.select().from(importJobs);
      return job as ImportJob;
    }

    it('attaches a staged item to the incumbent it matches by ASIN, end to end', async () => {
      withSettings({ folderFormat: '{author}/{title}' });
      const bookId = await seedIncumbent({
        authorName: 'Incumbent Author', book: { title: 'Incumbent Title', asin: 'B0STAGED01', status: 'wanted' },
      });
      await db.update(books).set({ status: 'wanted', path: null }).where(eq(books.id, bookId));
      const source = seedSource('staged');

      const job = await stage({
        path: source, title: 'Offered Title', asin: 'B0STAGED01',
        metadata: { title: 'Offered Title', authors: [{ name: 'Offered Author' }], asin: 'B0STAGED01' },
      });
      await adapter.process(job, adapterContext());

      expect(await db.select().from(books)).toHaveLength(1);
      const row = await rowOf(bookId);
      expect(row.status).toBe('imported');
      expect(posix(row.path!)).toContain('Incumbent Author/Incumbent Title');
      expect(row.size).toBeGreaterThan(0);
    });

    it('an OPF may CAUSE the attach and still changes nothing about the incumbent (AC24)', async () => {
      withSettings({ folderFormat: '{author}/{narrator}/{year}/{title}' });
      const bookId = await seedIncumbent({
        authorName: 'Incumbent Author', narrators: ['Incumbent Narrator'],
        book: { title: 'Incumbent Title', asin: 'B0OPFATT01', status: 'wanted', publishedDate: '1999-09-09', coverUrl: 'https://example.com/c.jpg' },
      });
      await db.update(books).set({ status: 'wanted', path: null, subtitle: null, publisher: null }).where(eq(books.id, bookId));
      // The item's OWN identity does not match; only the sidecar carries the incumbent's ASIN.
      const source = seedSource('opf-staged', [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
        '    <dc:title>Opf Title</dc:title>',
        '    <dc:subtitle>Opf Subtitle</dc:subtitle>',
        '    <dc:creator opf:role="nrt">Opf Narrator</dc:creator>',
        '    <dc:description>Opf Description</dc:description>',
        '    <dc:publisher>Opf Publisher</dc:publisher>',
        '    <dc:date>2011-11-11</dc:date>',
        '    <dc:subject>Opf Genre</dc:subject>',
        '    <dc:identifier opf:scheme="ASIN">B0OPFATT01</dc:identifier>',
        '  </metadata>',
        '</package>',
        '',
      ].join('\n'));

      const job = await stage({ path: source, title: 'Offered Title', metadata: { title: 'Offered Title', authors: [{ name: 'Offered Author' }] } });
      // The item classified as an attach, proving the pre-classification overlay still runs.
      expect(job.bookId).toBe(bookId);
      await adapter.process(job, adapterContext());

      const row = await rowOf(bookId);
      const path = posix(row.path!);
      expect(path).toContain('Incumbent Author/Incumbent Narrator/1999/Incumbent Title');
      expect(path).not.toContain('Opf');
      // Post-attach the sidecar writes nothing: empty stays empty rather than being filled.
      expect(row.subtitle).toBeNull();
      expect(row.publisher).toBeNull();
      expect(row.genres).toBeNull();
      expect(row.coverUrl).toBe('https://example.com/c.jpg');
      const detail = await bookService.getById(bookId);
      expect(detail!.narrators.map((n) => n.name)).toEqual(['Incumbent Narrator']);
    });
  });
});
