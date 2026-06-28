import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cheerio from 'cheerio';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  // Default: no existing OPF on disk (ENOENT) → the writer is free to write.
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

import { readFile, writeFile } from 'node:fs/promises';
import { generateOpf, writeOpfForImport } from './opf-writer.js';
import { parseOpfMetadata } from './abs-opf-parser.fixture.js';
import { NARRATORR_OPF_MARKER } from '../../core/utils/opf-regex.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';

/** Wrap raw `<metadata>` children in a minimal OPF 2.0 package — for hand-built drift/negative cases. */
function rawOpf(metadataInner: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    metadataInner,
    '  </metadata>',
    '</package>',
    '',
  ].join('\n');
}

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
  it('series meta pair is adjacent (calibre:series immediately followed by calibre:series_index)', () => {
    const opf = generateOpf(makeBook({ seriesName: 'Saga', seriesPosition: 2 }));
    expect(opf).toContain(
      '    <meta name="calibre:series" content="Saga"/>\n    <meta name="calibre:series_index" content="2"/>',
    );
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

  it('embeds the narratorr provenance marker inside <metadata>, inert to the parsed fields (#1674)', () => {
    const opf = generateOpf(makeBook({ title: 'Owned', asin: 'B00ASIN123', seriesName: 'S', seriesPosition: 1 }));
    // The raw marker element is present...
    expect(opf).toContain(NARRATORR_OPF_MARKER);
    const $ = cheerio.load(opf, { xmlMode: true });
    // ...sits inside <metadata>...
    expect($('metadata meta[name="narratorr:managed"]').attr('content')).toBe('true');
    // ...and is inert: it perturbs none of the fields a reader extracts.
    expect($('dc\\:title').text()).toBe('Owned');
    expect($('dc\\:identifier[opf\\:scheme="ASIN"]').text()).toBe('B00ASIN123');
    expect($('meta[name="calibre:series"]').attr('content')).toBe('S');
    expect($('package').attr('version')).toBe('2.0');
  });
});

// The authoritative ABS-compatibility guarantee: assert generateOpf's output against the ACTUAL
// Audiobookshelf field mapping (parseOpfMetadata.js, pinned in abs-opf-parser.fixture.ts), not the
// Cheerio "a selector found the tag" check above. A tag-presence check passes while the real ABS
// field mapping silently breaks (wrong opf:role, scheme casing, series-meta adjacency); these do not.
describe('generateOpf — ABS parseOpfMetadata contract', () => {
  it('round-trips a representative book to ABS\'s exact extracted shape', () => {
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
      authors: names([{ name: 'A1' }, { name: 'A2' }]) as BookWithAuthor['authors'],
      narrators: names([{ name: 'N1' }, { name: 'N2' }]) as BookWithAuthor['narrators'],
    }));

    const parsed = parseOpfMetadata(opf);

    expect(parsed).toMatchObject({
      title: 'A Title',
      subtitle: 'A Subtitle',
      description: 'A description.',
      publisher: 'A Publisher',
      publishedYear: '2021', // year only, not the full dc:date
      authors: ['A1', 'A2'], // ordered, role-bucketed
      narrators: ['N1', 'N2'],
      asin: 'B00ASIN123',
      isbn: '9781234567890',
      series: [{ name: 'My Series', sequence: '3' }], // sequence is a string
      genres: ['Fantasy', 'Adventure'],
    });
    // Fields narratorr never emits stay at ABS's empty defaults.
    expect(parsed.language).toBeNull();
    expect(parsed.tags).toEqual([]);
  });

  describe('creator role bucketing', () => {
    it('separates aut/nrt creators into ordered arrays', () => {
      const opf = generateOpf(makeBook({
        authors: names([{ name: 'First Author' }, { name: 'Second Author' }]) as BookWithAuthor['authors'],
        narrators: names([{ name: 'First Narrator' }, { name: 'Second Narrator' }]) as BookWithAuthor['narrators'],
      }));
      const parsed = parseOpfMetadata(opf);
      expect(parsed.authors).toEqual(['First Author', 'Second Author']);
      expect(parsed.narrators).toEqual(['First Narrator', 'Second Narrator']);
    });

    it('does NOT bucket a dc:creator with no opf:role (or a wrong role) — true ABS failure mode', () => {
      const parsed = parseOpfMetadata(rawOpf([
        '    <dc:title>X</dc:title>',
        '    <dc:creator>No Role</dc:creator>',
        '    <dc:creator opf:role="edt">Wrong Role</dc:creator>',
      ].join('\n')));
      expect(parsed.authors).toEqual([]);
      expect(parsed.narrators).toEqual([]);
    });
  });

  describe('identifier scheme keying', () => {
    it.each([
      { asin: 'B00ASIN123', isbn: null, expected: { asin: 'B00ASIN123', isbn: null } },
      { asin: null, isbn: '9781234567890', expected: { asin: null, isbn: '9781234567890' } },
      { asin: 'B00ASIN123', isbn: '9781234567890', expected: { asin: 'B00ASIN123', isbn: '9781234567890' } },
    ])('reads flat asin/isbn by case-sensitive scheme (asin=$asin isbn=$isbn)', ({ asin, isbn, expected }) => {
      const parsed = parseOpfMetadata(generateOpf(makeBook({ asin, isbn })));
      expect(parsed.asin).toBe(expected.asin);
      expect(parsed.isbn).toBe(expected.isbn);
    });

    it('yields null when dc:identifier is missing its opf:scheme — true ABS failure mode', () => {
      const parsed = parseOpfMetadata(rawOpf([
        '    <dc:title>X</dc:title>',
        '    <dc:identifier>B00NOSCHEME</dc:identifier>',
      ].join('\n')));
      expect(parsed.asin).toBeNull();
      expect(parsed.isbn).toBeNull();
    });
  });

  describe('series adjacency, fallback, and boundaries', () => {
    it('reads the adjacent series_index as a string sequence', () => {
      const parsed = parseOpfMetadata(generateOpf(makeBook({ seriesName: 'My Series', seriesPosition: 3 })));
      expect(parsed.series).toEqual([{ name: 'My Series', sequence: '3' }]);
    });

    it('round-trips seriesPosition 0 as sequence "0" (string, not dropped)', () => {
      const parsed = parseOpfMetadata(generateOpf(makeBook({ seriesName: 'Zero Saga', seriesPosition: 0 })));
      expect(parsed.series).toEqual([{ name: 'Zero Saga', sequence: '0' }]);
    });

    it('yields sequence null for a series with no index and no stray series_index', () => {
      const parsed = parseOpfMetadata(generateOpf(makeBook({ seriesName: 'No Index Saga', seriesPosition: null })));
      expect(parsed.series).toEqual([{ name: 'No Index Saga', sequence: null }]);
    });

    it('recovers a non-adjacent series_index via ABS\'s single-series fallback', () => {
      const parsed = parseOpfMetadata(rawOpf([
        '    <dc:title>X</dc:title>',
        '    <meta name="calibre:series" content="Solo"/>',
        '    <meta name="calibre:rating" content="5"/>',
        '    <meta name="calibre:series_index" content="7"/>',
      ].join('\n')));
      expect(parsed.series).toEqual([{ name: 'Solo', sequence: '7' }]);
    });
  });

  describe('subjects → genres and date → year', () => {
    it('exposes ordered genres and an empty array when genres is null', () => {
      expect(parseOpfMetadata(generateOpf(makeBook({ genres: ['Fantasy', 'Adventure'] }))).genres)
        .toEqual(['Fantasy', 'Adventure']);
      expect(parseOpfMetadata(generateOpf(makeBook({ genres: null }))).genres).toEqual([]);
    });

    it('reduces dc:date to the year, and yields null for a non-4-digit date', () => {
      expect(parseOpfMetadata(generateOpf(makeBook({ publishedDate: '2021-05-01' }))).publishedYear).toBe('2021');
      expect(parseOpfMetadata(generateOpf(makeBook({ publishedDate: 'garbage' }))).publishedYear).toBeNull();
    });
  });

  it('collapses duplicate author, narrator, and genre values to one (ABS new Set), first-seen order', () => {
    const opf = generateOpf(makeBook({
      authors: names([{ name: 'Dup' }, { name: 'Dup' }, { name: 'Other' }]) as BookWithAuthor['authors'],
      narrators: names([{ name: 'NDup' }, { name: 'NDup' }]) as BookWithAuthor['narrators'],
      genres: ['Sci-Fi', 'Sci-Fi', 'Horror'],
    }));
    const parsed = parseOpfMetadata(opf);
    expect(parsed.authors).toEqual(['Dup', 'Other']);
    expect(parsed.narrators).toEqual(['NDup']);
    expect(parsed.genres).toEqual(['Sci-Fi', 'Horror']);
  });

  it('un-escapes and strips HTML in dc:description (mirrors ABS fetchDescription)', () => {
    // The writer escapes a literal '<b>' to '&lt;b&gt;'; ABS un-escapes then strips the tag.
    const parsed = parseOpfMetadata(generateOpf(makeBook({ description: 'Bold <b>word</b> here' })));
    expect(parsed.description).toBe('Bold word here');
  });

  it('treats the narratorr:managed marker as inert — it produces no field (#1674)', () => {
    // The marker is a <meta> that lives in the same array fetchSeries scans; prove it pollutes nothing.
    const parsed = parseOpfMetadata(generateOpf(makeBook({ title: 'Owned', asin: 'B00ASIN123' })));
    expect(parsed.title).toBe('Owned');
    expect(parsed.asin).toBe('B00ASIN123');
    expect(parsed.series).toEqual([]); // the marker <meta> is not misread as a series entry
    expect(JSON.stringify(parsed)).not.toContain('narratorr:managed');
  });

  it('drift sentinel: a corrupted opf:role / dropped opf:scheme no longer round-trips (regression the Cheerio check missed)', () => {
    // A future shape regression that keeps the XML well-formed but breaks ABS's field mapping.
    const drifted = rawOpf([
      '    <dc:title>X</dc:title>',
      '    <dc:creator opf:role="author">Jane</dc:creator>', // 'author' ≠ ABS's 'aut'
      '    <dc:identifier opf:Scheme="ASIN">B00ASIN123</dc:identifier>', // wrong-case attr name
    ].join('\n'));
    const parsed = parseOpfMetadata(drifted);
    expect(parsed.authors).toEqual([]); // creator unbucketed
    expect(parsed.asin).toBeNull(); // identifier unread
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

  const readFileMock = vi.mocked(readFile);

  it('writes when the target OPF does not exist (ENOENT pre-check → write) (#1674)', async () => {
    const { service } = makeBookService(makeBook());
    readFileMock.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await writeOpfForImport({ enabled: true, bookService: service, bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('overwrites an existing OPF that carries the narratorr marker (#1674)', async () => {
    const { service } = makeBookService(makeBook());
    readFileMock.mockResolvedValueOnce(`<metadata>\n  ${NARRATORR_OPF_MARKER}\n</metadata>`);
    await writeOpfForImport({ enabled: true, bookService: service, bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT overwrite an existing unmarked (foreign) OPF — skip + warn, no throw (#1674)', async () => {
    const { service } = makeBookService(makeBook());
    readFileMock.mockResolvedValueOnce('<?xml version="1.0"?><package><metadata><dc:title>ABS</dc:title></metadata></package>');
    const log = makeLog();
    await expect(
      writeOpfForImport({ enabled: true, bookService: service, bookId: 1, bookFolder: '/lib/Book', log }),
    ).resolves.toBeUndefined();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ opfPath: expect.stringContaining('metadata.opf') }),
      expect.stringContaining('foreign'),
    );
  });

  it('fails safe on a read error during the pre-check — skip + warn, no write (#1674)', async () => {
    const { service } = makeBookService(makeBook());
    readFileMock.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const log = makeLog();
    await expect(
      writeOpfForImport({ enabled: true, bookService: service, bookId: 1, bookFolder: '/lib/Book', log }),
    ).resolves.toBeUndefined();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ opfPath: expect.stringContaining('metadata.opf') }),
      expect.stringContaining('skipping'),
    );
  });
});
