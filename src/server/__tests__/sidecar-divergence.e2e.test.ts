import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { bookEvents, books } from '@db/schema.js';
import { NARRATORR_OPF_MARKER } from '@core/utils/opf-regex.js';
import { createE2EApp, seedBookAndDownload, type E2EApp } from './e2e-helpers.js';
import { QB_BASE, TORRENT_HASH, qbLoginHandler, qbGetTorrentHandler } from './msw-handlers.js';

// Real audio parsing needs valid media; these fixtures exercise only the import flow.
vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

const mswServer = setupServer();

const CURATED_SIDECAR = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
  '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
  `    ${NARRATORR_OPF_MARKER}`,
  '    <dc:title>Mort</dc:title>',
  '    <meta name="calibre:series" content="Discworld"/>',
  '    <meta name="calibre:series_index" content="4"/>',
  '  </metadata>',
  '</package>',
  '',
].join('\n');

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('Sidecar divergence E2E (#2297)', () => {
  let e2e: E2EApp;
  let downloadParent: string;
  let libraryDir: string;
  let downloadClientId: number;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'bypass' });
    e2e = await createE2EApp();

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-2297-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-2297-lib-'));

    const source = join(downloadParent, 'Test Audiobook');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'book.m4b'), Buffer.alloc(1024));

    const clientRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/download-clients',
      payload: {
        name: 'Test qBittorrent', type: 'qbittorrent', enabled: true, priority: 50,
        settings: { host: 'localhost', port: 8080, username: 'admin', password: 'password', useSsl: false },
      },
    });
    expect(clientRes.statusCode).toBe(201);
    downloadClientId = clientRes.json().id;

    await e2e.services.settings.set('library', {
      path: libraryDir,
      folderFormat: '{author}/{title}',
      fileFormat: '{author} - {title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    await e2e.services.settings.set('import', {
      deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 0, redownloadFailed: true,
    });

    const tagging = await e2e.services.settings.get('tagging');
    await e2e.services.settings.set('tagging', { ...tagging, writeOpf: true });
  });

  afterEach(() => {
    mswServer.resetHandlers();
    e2e.services.downloadClient.clearAdapterCache();
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
    await rm(downloadParent, { recursive: true, force: true }).catch(() => { /* tolerant */ });
    await rm(libraryDir, { recursive: true, force: true }).catch(() => { /* tolerant */ });
  });

  it('preserves the curated sidecar on disk and surfaces the divergence over the API', async () => {
    const { bookId, downloadId } = await seedBookAndDownload(e2e, downloadClientId, 'Mort', 'Terry Pratchett');
    const target = join(libraryDir, 'Terry Pratchett', 'Mort');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'metadata.opf'), CURATED_SIDECAR, 'utf-8');

    mswServer.use(qbLoginHandler(QB_BASE), qbGetTorrentHandler(TORRENT_HASH, downloadParent));
    await e2e.services.importOrchestrator.importDownload(downloadId);

    // 1. The bytes: exactly what was on disk before the overwrite, untouched by any decode.
    expect(await readFile(join(target, 'metadata.opf.bak'), 'utf-8')).toBe(CURATED_SIDECAR);

    // 2. The replacement: the DB's values, still narratorr-marked.
    const rewritten = await readFile(join(target, 'metadata.opf'), 'utf-8');
    expect(rewritten).toContain(NARRATORR_OPF_MARKER);
    expect(rewritten).toContain('<dc:creator opf:role="aut">Terry Pratchett</dc:creator>');
    expect(rewritten).not.toContain('calibre:series');

    // 3. The discovery record, through the operator's own query.
    const res = await e2e.app.inject({ method: 'GET', url: '/api/event-history?eventType=sidecar_diverged' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: Array<Record<string, unknown>> };
    expect(data).toHaveLength(1);

    const event = data[0]!;
    expect(event.bookId).toBe(bookId);
    expect(event.source).toBe('auto');
    // The location is composed at display time from this, never stored on the append-only row.
    expect(String(event.bookPath).split('\\').join('/')).toBe(target.split('\\').join('/'));

    const reason = event.reason as { changed_fields: string[]; previous: Record<string, unknown> };
    expect(reason.changed_fields).toContain('seriesName');
    expect(reason.previous).toMatchObject({ seriesName: 'Discworld', seriesPosition: 4 });
    expect(JSON.stringify(reason)).not.toContain('metadata.opf.bak');
  });

  // Continues from the import above: the artifacts it produced are what retention must not reach.
  it('housekeeping retention prunes the record but never reaches the backup file', async () => {
    const target = join(libraryDir, 'Terry Pratchett', 'Mort');
    expect(await exists(join(target, 'metadata.opf.bak'))).toBe(true);

    // Age the row past retention; the job operates on the database only.
    await e2e.db.update(bookEvents)
      .set({ createdAt: new Date(Date.now() - 200 * 86_400_000) })
      .where(eq(bookEvents.eventType, 'sidecar_diverged'));

    const pruned = await e2e.services.eventHistory.pruneOlderThan(90);
    expect(pruned).toBeGreaterThanOrEqual(1);

    const res = await e2e.app.inject({ method: 'GET', url: '/api/event-history?eventType=sidecar_diverged' });
    expect((res.json() as { data: unknown[] }).data).toHaveLength(0);
    // The recovery artifact does not live in the database.
    expect(await readFile(join(target, 'metadata.opf.bak'), 'utf-8')).toBe(CURATED_SIDECAR);
  });

  it('is not exempt from single delete or from Clear All', async () => {
    const created = await e2e.services.eventHistory.create({
      bookTitle: 'Mort', eventType: 'sidecar_diverged', source: 'manual',
      reason: { changed_fields: ['publisher'], previous: { publisher: 'Gollancz' } },
    });

    const single = await e2e.app.inject({ method: 'DELETE', url: `/api/event-history/${created.id}` });
    expect(single.statusCode).toBe(200);

    await e2e.services.eventHistory.create({
      bookTitle: 'Mort', eventType: 'sidecar_diverged', source: 'manual', reason: { changed_fields: [], previous: {} },
    });
    const bulk = await e2e.app.inject({ method: 'DELETE', url: '/api/event-history?eventType=sidecar_diverged' });
    expect(bulk.json()).toEqual({ deleted: 1 });

    const clearAll = await e2e.services.eventHistory.create({
      bookTitle: 'Mort', eventType: 'sidecar_diverged', source: 'manual', reason: { changed_fields: [], previous: {} },
    });
    await e2e.app.inject({ method: 'DELETE', url: '/api/event-history' });
    expect(await e2e.services.eventHistory.getById(clearAll.id)).toBeNull();
  });

  // F36: the renderer composes the backup location from this, so it must track the book, not the row.
  it('projects the CURRENT book folder onto the event, following renames and going null on delete', async () => {
    const bookRes = await e2e.app.inject({
      method: 'POST', url: '/api/books', payload: { title: 'Path Tracking', authors: [{ name: 'Tester' }] },
    });
    const bookId = bookRes.json().id as number;
    await e2e.db.update(books).set({ path: '/library/Tester/Before' }).where(eq(books.id, bookId));
    await e2e.services.eventHistory.create({
      bookId, bookTitle: 'Path Tracking', eventType: 'sidecar_diverged', source: 'auto',
      reason: { changed_fields: ['publisher'], previous: { publisher: 'Gollancz' } },
    });

    const readBack = async () => {
      const res = await e2e.app.inject({ method: 'GET', url: '/api/event-history?eventType=sidecar_diverged' });
      return (res.json() as { data: Array<Record<string, unknown>> }).data[0]!;
    };

    expect((await readBack()).bookPath).toBe('/library/Tester/Before');

    await e2e.db.update(books).set({ path: '/library/Tester/After' }).where(eq(books.id, bookId));
    // A path stored on the append-only row would still say "Before" here.
    expect((await readBack()).bookPath).toBe('/library/Tester/After');

    await e2e.db.delete(books).where(eq(books.id, bookId));
    const orphaned = await readBack();
    expect(orphaned.bookId).toBeNull();
    expect(orphaned.bookPath).toBeNull();
    expect(orphaned.bookTitle).toBe('Path Tracking');
  });

  // The book-scoped endpoint feeds the Activity cards on a book's detail page and projects the
  // path through its own query, so the all-events lifecycle above cannot stand in for it.
  it('projects the current folder on the BOOK-SCOPED event query too, following renames', async () => {
    const bookRes = await e2e.app.inject({
      method: 'POST', url: '/api/books', payload: { title: 'Book Scoped', authors: [{ name: 'Tester' }] },
    });
    const bookId = bookRes.json().id as number;
    await e2e.db.update(books).set({ path: '/library/Tester/Scoped Before' }).where(eq(books.id, bookId));
    await e2e.services.eventHistory.create({
      bookId, bookTitle: 'Book Scoped', eventType: 'sidecar_diverged', source: 'auto',
      reason: { changed_fields: ['seriesName'], previous: { seriesName: 'Discworld' } },
    });

    const readBack = async () => {
      const res = await e2e.app.inject({ method: 'GET', url: `/api/event-history/books/${bookId}` });
      expect(res.statusCode).toBe(200);
      return res.json() as Array<Record<string, unknown>>;
    };

    const [event] = await readBack();
    // Deleting the join or the projection from getByBookId leaves this undefined, and the
    // book-detail card then tells the operator the backup location is gone.
    expect(event!.bookPath).toBe('/library/Tester/Scoped Before');
    expect(event!.eventType).toBe('sidecar_diverged');
    expect(event!.reason).toEqual({ changed_fields: ['seriesName'], previous: { seriesName: 'Discworld' } });

    await e2e.db.update(books).set({ path: '/library/Tester/Scoped After' }).where(eq(books.id, bookId));
    expect((await readBack())[0]!.bookPath).toBe('/library/Tester/Scoped After');

    // Deleting the book nulls the FK, so the event leaves this endpoint's scope entirely.
    await e2e.db.delete(books).where(eq(books.id, bookId));
    expect(await readBack()).toEqual([]);
  });
});
