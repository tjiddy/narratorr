import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cheerio from 'cheerio';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { writeFile } from 'node:fs/promises';
import { generateOpf, writeOpfForImport } from './opf-writer.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 1,
    title: 'The Book',
    subtitle: null,
    description: null,
    publisher: null,
    coverUrl: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    publishedDate: null,
    genres: null,
    authors: [],
    narrators: [],
    ...overrides,
  } as unknown as BookWithAuthor;
}

const names = (people: { name: string }[]): { name: string }[] => people;

describe('generateOpf', () => {
  it('emits every supported field in the exact ABS parseOpfMetadata shape (fixture-parse)', () => {
    const opf = generateOpf(makeBook({
      title: 'A Title',
      subtitle: 'A Subtitle',
      description: 'A description.',
      publisher: 'A Publisher',
      publishedDate: '2021-05-01',
      asin: 'B00ASIN123',
      isbn: '9781234567890',
      seriesName: 'My Series',
      seriesPosition: 3,
      genres: ['Fantasy', 'Adventure'],
      authors: names([{ name: 'Jane Author' }]) as BookWithAuthor['authors'],
      narrators: names([{ name: 'Nick Narrator' }]) as BookWithAuthor['narrators'],
    }));

    const $ = cheerio.load(opf, { xmlMode: true });

    expect($('dc\\:title').text()).toBe('A Title');
    expect($('dc\\:subtitle').text()).toBe('A Subtitle');
    expect($('dc\\:description').text()).toBe('A description.');
    expect($('dc\\:publisher').text()).toBe('A Publisher');
    expect($('dc\\:date').text()).toBe('2021-05-01');

    const creators = $('dc\\:creator').toArray();
    const authors = creators.filter((el) => $(el).attr('opf:role') === 'aut').map((el) => $(el).text());
    const narrators = creators.filter((el) => $(el).attr('opf:role') === 'nrt').map((el) => $(el).text());
    expect(authors).toEqual(['Jane Author']);
    expect(narrators).toEqual(['Nick Narrator']);

    const ids = $('dc\\:identifier').toArray();
    const byScheme = (scheme: string) => ids.filter((el) => $(el).attr('opf:scheme') === scheme).map((el) => $(el).text());
    expect(byScheme('ASIN')).toEqual(['B00ASIN123']);
    expect(byScheme('ISBN')).toEqual(['9781234567890']);

    const metas = $('meta').toArray();
    const metaContent = (name: string) => metas.filter((el) => $(el).attr('name') === name).map((el) => $(el).attr('content'));
    expect(metaContent('calibre:series')).toEqual(['My Series']);
    expect(metaContent('calibre:series_index')).toEqual(['3']);

    const subjects = $('dc\\:subject').toArray().map((el) => $(el).text());
    expect(subjects).toEqual(['Fantasy', 'Adventure']);

    // No dc:language (no DB column this phase) and no cover reference.
    expect(opf).not.toContain('dc:language');
    expect(opf).not.toContain('cover');
  });

  it('series meta pair is adjacent (calibre:series immediately followed by calibre:series_index)', () => {
    const opf = generateOpf(makeBook({ seriesName: 'Saga', seriesPosition: 2 }));
    expect(opf).toContain(
      '    <meta name="calibre:series" content="Saga"/>\n    <meta name="calibre:series_index" content="2"/>',
    );
  });

  it('emits one dc:creator per author in source order', () => {
    const opf = generateOpf(makeBook({
      authors: names([{ name: 'First Author' }, { name: 'Second Author' }]) as BookWithAuthor['authors'],
    }));
    const $ = cheerio.load(opf, { xmlMode: true });
    const authors = $('dc\\:creator').toArray().filter((el) => $(el).attr('opf:role') === 'aut').map((el) => $(el).text());
    expect(authors).toEqual(['First Author', 'Second Author']);
  });

  it('emits one dc:creator per narrator in source order', () => {
    const opf = generateOpf(makeBook({
      narrators: names([{ name: 'First Narrator' }, { name: 'Second Narrator' }]) as BookWithAuthor['narrators'],
    }));
    const $ = cheerio.load(opf, { xmlMode: true });
    const narrators = $('dc\\:creator').toArray().filter((el) => $(el).attr('opf:role') === 'nrt').map((el) => $(el).text());
    expect(narrators).toEqual(['First Narrator', 'Second Narrator']);
  });

  it('escapes XML special characters in text and attributes and round-trips back to the raw values', () => {
    const opf = generateOpf(makeBook({
      title: 'Tom & Jerry <"\'>',
      description: 'a < b & c > d "quote" \'apos\'',
      seriesName: 'A & B',
      authors: names([{ name: 'X & Y' }]) as BookWithAuthor['authors'],
    }));

    // Raw output carries entity escapes, never a bare ampersand.
    expect(opf).toContain('&amp;');
    expect(opf).toContain('&lt;');
    expect(opf).toContain('&gt;');
    expect(opf).toContain('&quot;');
    expect(opf).toContain('&apos;');
    expect(opf).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);

    // Parsing yields the original raw strings back (well-formed entity handling).
    const $ = cheerio.load(opf, { xmlMode: true });
    expect($('dc\\:title').text()).toBe('Tom & Jerry <"\'>');
    expect($('dc\\:description').text()).toBe('a < b & c > d "quote" \'apos\'');
    expect($('dc\\:creator').text()).toBe('X & Y');
    expect($('meta[name="calibre:series"]').attr('content')).toBe('A & B');
  });

  it('omits missing optional fields entirely (no empty or stray elements)', () => {
    const opf = generateOpf(makeBook({ title: 'Bare' }));
    expect(opf).toContain('<dc:title>Bare</dc:title>');
    expect(opf).not.toContain('dc:subtitle');
    expect(opf).not.toContain('dc:description');
    expect(opf).not.toContain('dc:publisher');
    expect(opf).not.toContain('dc:date');
    expect(opf).not.toContain('dc:identifier');
    expect(opf).not.toContain('dc:creator');
    expect(opf).not.toContain('dc:subject');
    expect(opf).not.toContain('calibre:series');
  });

  it('emits series_index for a legitimate position of 0 (not dropped by a falsy guard)', () => {
    const opf = generateOpf(makeBook({ seriesName: 'Zero Saga', seriesPosition: 0 }));
    const $ = cheerio.load(opf, { xmlMode: true });
    expect($('meta[name="calibre:series_index"]').attr('content')).toBe('0');
  });

  it('emits calibre:series without series_index when seriesPosition is null', () => {
    const opf = generateOpf(makeBook({ seriesName: 'No Index Saga', seriesPosition: null }));
    expect(opf).toContain('name="calibre:series"');
    expect(opf).not.toContain('calibre:series_index');
  });

  it('produces a well-formed document that parses and re-extracts its title', () => {
    const opf = generateOpf(makeBook({ title: 'Parse Me', genres: ['G1'] }));
    expect(opf.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    const $ = cheerio.load(opf, { xmlMode: true });
    expect($('package').attr('version')).toBe('2.0');
    expect($('dc\\:title').text()).toBe('Parse Me');
  });
});

describe('writeOpfForImport', () => {
  const writeFileMock = vi.mocked(writeFile);

  function makeBookService(book: BookWithAuthor | null): { service: BookService; getById: ReturnType<typeof vi.fn> } {
    const getById = vi.fn().mockResolvedValue(book);
    return { service: { getById } as unknown as BookService, getById };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when disabled — no fresh load, no write', async () => {
    const { service, getById } = makeBookService(makeBook());
    await writeOpfForImport({ enabled: false, bookService: service, bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
    expect(getById).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('loads the book fresh by id and writes metadata.opf into the book folder', async () => {
    const book = makeBook({ id: 42, title: 'Fresh', authors: names([{ name: 'A' }]) as BookWithAuthor['authors'] });
    const { service, getById } = makeBookService(book);
    await writeOpfForImport({ enabled: true, bookService: service, bookId: 42, bookFolder: '/lib/Author/Fresh', log: makeLog() });

    expect(getById).toHaveBeenCalledWith(42);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [path, content, encoding] = writeFileMock.mock.calls[0]!;
    expect(String(path).split('\\').join('/')).toBe('/lib/Author/Fresh/metadata.opf');
    expect(content).toBe(generateOpf(book));
    expect(encoding).toBe('utf-8');
  });

  it('reflects a narrator added after the snapshot (proves fresh reload, not a stale book)', async () => {
    // The helper reads getById's return — a record carrying an enrichment-added narrator.
    const enriched = makeBook({ id: 7, narrators: names([{ name: 'Late Narrator' }]) as BookWithAuthor['narrators'] });
    const { service } = makeBookService(enriched);
    await writeOpfForImport({ enabled: true, bookService: service, bookId: 7, bookFolder: '/lib/Book', log: makeLog() });
    const content = String(writeFileMock.mock.calls[0]![1]);
    expect(content).toContain('<dc:creator opf:role="nrt">Late Narrator</dc:creator>');
  });

  it('skips the write when the book is not found', async () => {
    const { service } = makeBookService(null);
    const log = makeLog();
    await writeOpfForImport({ enabled: true, bookService: service, bookId: 99, bookFolder: '/lib/Book', log });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('is nonfatal when writeFile rejects — no throw, warn logged', async () => {
    const { service } = makeBookService(makeBook());
    writeFileMock.mockRejectedValueOnce(new Error('EACCES'));
    const log = makeLog();
    await expect(
      writeOpfForImport({ enabled: true, bookService: service, bookId: 1, bookFolder: '/lib/Book', log }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      expect.stringContaining('continuing'),
    );
  });
});
