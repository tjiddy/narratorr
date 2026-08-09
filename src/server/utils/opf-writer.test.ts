import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cheerio from 'cheerio';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  // Default to no existing OPF.
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
}));

import { readFile, writeFile } from 'node:fs/promises';
import { generateOpf, writeOpfForImport, writeOpfSidecar } from './opf-writer.js';
import { parseOpfMetadata } from './abs-opf-parser.fixture.js';
import { NARRATORR_OPF_MARKER } from '@core/utils/opf-regex.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';

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

    expect(opf).toContain('&amp;');
    expect(opf).toContain('&lt;');
    expect(opf).toContain('&gt;');
    expect(opf).toContain('&quot;');
    expect(opf).toContain('&apos;');
    expect(opf).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);

    const $ = cheerio.load(opf, { xmlMode: true });
    expect($('dc\\:title').text()).toBe('Tom & Jerry <"\'>');
    expect($('dc\\:description').text()).toBe('a < b & c > d "quote" \'apos\'');
    expect($('dc\\:creator').text()).toBe('X & Y');
    expect($('meta[name="calibre:series"]').attr('content')).toBe('A & B');
  });

  it('strips XML-1.0-invalid control characters from every serialized field, leaving valid XML (#1675)', () => {
    const ctrl = '\x00\x08\x0B\x0C\x0E\x1F';
    const opf = generateOpf(makeBook({
      title: `Ti${ctrl}tle`,
      description: `De${ctrl}scription`,
      publisher: `Pu${ctrl}blisher`,
      seriesName: `Se${ctrl}ries`,
      authors: names([{ name: `Au${ctrl}thor` }]) as BookWithAuthor['authors'],
      narrators: names([{ name: `Na${ctrl}rrator` }]) as BookWithAuthor['narrators'],
    }));

    // eslint-disable-next-line no-control-regex
    expect(opf).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);

    const $ = cheerio.load(opf, { xmlMode: true });
    expect($('dc\\:title').text()).toBe('Title');
    expect($('dc\\:description').text()).toBe('Description');
    expect($('dc\\:publisher').text()).toBe('Publisher');
    expect($('meta[name="calibre:series"]').attr('content')).toBe('Series');
    const creators = $('dc\\:creator').map((_i, el) => $(el).text()).get();
    expect(creators).toEqual(['Author', 'Narrator']);
  });

  it('preserves XML-1.0-valid whitespace (tab \\x09, newline \\x0A, CR \\x0D) and the entity escaping (#1675)', () => {
    const opf = generateOpf(makeBook({ title: 'A\tB\nC\rD & E' }));
    expect(opf).toContain('&amp;');
    expect(opf).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(opf).toMatch(/A\tB\nC\rD/);
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
    expect(opf).toContain(NARRATORR_OPF_MARKER);
    const $ = cheerio.load(opf, { xmlMode: true });
    expect($('metadata meta[name="narratorr:managed"]').attr('content')).toBe('true');
    expect($('dc\\:title').text()).toBe('Owned');
    expect($('dc\\:identifier[opf\\:scheme="ASIN"]').text()).toBe('B00ASIN123');
    expect($('meta[name="calibre:series"]').attr('content')).toBe('S');
    expect($('package').attr('version')).toBe('2.0');
  });
});

// Assert against pinned Audiobookshelf selection semantics, not generic tag presence.
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
      publishedYear: '2021',
      authors: ['A1', 'A2'],
      narrators: ['N1', 'N2'],
      asin: 'B00ASIN123',
      isbn: '9781234567890',
      series: [{ name: 'My Series', sequence: '3' }],
      genres: ['Fantasy', 'Adventure'],
    });
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
    const parsed = parseOpfMetadata(generateOpf(makeBook({ description: 'Bold <b>word</b> here' })));
    expect(parsed.description).toBe('Bold word here');
  });

  it('treats the narratorr:managed marker as inert — it produces no field (#1674)', () => {
    const parsed = parseOpfMetadata(generateOpf(makeBook({ title: 'Owned', asin: 'B00ASIN123' })));
    expect(parsed.title).toBe('Owned');
    expect(parsed.asin).toBe('B00ASIN123');
    expect(parsed.series).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('narratorr:managed');
  });

  it('drift sentinel: a corrupted opf:role / dropped opf:scheme no longer round-trips (regression the Cheerio check missed)', () => {
    const drifted = rawOpf([
      '    <dc:title>X</dc:title>',
      '    <dc:creator opf:role="author">Jane</dc:creator>',
      '    <dc:identifier opf:Scheme="ASIN">B00ASIN123</dc:identifier>',
    ].join('\n'));
    const parsed = parseOpfMetadata(drifted);
    expect(parsed.authors).toEqual([]);
    expect(parsed.asin).toBeNull();
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

  it('skips the write for a pointer single-file path (audio extension) — no write, warn logged (#1675)', async () => {
    // A pointer file's parent may be shared, so no sidecar location is safe.
    const { service, getById } = makeBookService(makeBook());
    const log = makeLog();
    await writeOpfForImport({ enabled: true, bookService: service, bookId: 1, bookFolder: '/audiobooks/Doctor Sleep.m4b', log });

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookFolder: expect.stringContaining('Doctor Sleep') }),
      expect.stringContaining('single-file'),
    );
  });

  it('reflects a narrator added after the snapshot (proves fresh reload, not a stale book)', async () => {
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

describe('writeOpfSidecar — result API (#1670)', () => {
  const writeFileMock = vi.mocked(writeFile);
  const readFileMock = vi.mocked(readFile);

  function makeBookService(book: BookWithAuthor | null): BookService {
    return { getById: vi.fn().mockResolvedValue(book) } as unknown as BookService;
  }

  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 'written' on a fresh/marked target", async () => {
    const outcome = await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
    expect(outcome).toBe('written');
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns 'skipped' when disabled — no fresh load, no write", async () => {
    const outcome = await writeOpfSidecar({ enabled: false, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
    expect(outcome).toBe('skipped');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("returns 'skipped' for a single-file pointer path", async () => {
    const outcome = await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/audiobooks/Doctor Sleep.m4b', log: makeLog() });
    expect(outcome).toBe('skipped');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("returns 'skipped' when the book is missing", async () => {
    const outcome = await writeOpfSidecar({ enabled: true, bookService: makeBookService(null), bookId: 9, bookFolder: '/lib/Book', log: makeLog() });
    expect(outcome).toBe('skipped');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("returns 'skipped' for a foreign (unmarked) existing OPF", async () => {
    readFileMock.mockResolvedValueOnce('<?xml version="1.0"?><package><metadata><dc:title>ABS</dc:title></metadata></package>');
    const outcome = await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
    expect(outcome).toBe('skipped');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("returns 'failed' when writeFile rejects", async () => {
    writeFileMock.mockRejectedValueOnce(new Error('EACCES'));
    const outcome = await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
    expect(outcome).toBe('failed');
  });

  it('writeOpfForImport wrapper stays void + nonfatal over a failing core (regression guard)', async () => {
    writeFileMock.mockRejectedValueOnce(new Error('EACCES'));
    await expect(
      writeOpfForImport({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog() }),
    ).resolves.toBeUndefined();
  });

  // The failure side channel preserves the caught value behind the string outcome.
  describe('onFailure side channel (#2159)', () => {
    it('receives the caught VALUE (not a message) when writeFile rejects', async () => {
      const cause = Object.assign(new Error("ENOENT: no such file or directory, open '/lib/Book/metadata.opf'"), { code: 'ENOENT' });
      writeFileMock.mockRejectedValueOnce(cause);
      const onFailure = vi.fn();

      const outcome = await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog(), onFailure });

      expect(outcome).toBe('failed');
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith(cause);
    });

    it('receives the caught value when the fresh book load rejects', async () => {
      const cause = new Error('DB locked');
      const bookService = { getById: vi.fn().mockRejectedValue(cause) } as unknown as BookService;
      const onFailure = vi.fn();

      const outcome = await writeOpfSidecar({ enabled: true, bookService, bookId: 1, bookFolder: '/lib/Book', log: makeLog(), onFailure });

      expect(outcome).toBe('failed');
      expect(onFailure).toHaveBeenCalledWith(cause);
    });

    it('is NOT invoked on any non-failed outcome', async () => {
      const onFailure = vi.fn();
      await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog(), onFailure });
      await writeOpfSidecar({ enabled: false, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog(), onFailure });
      await writeOpfSidecar({ enabled: true, bookService: makeBookService(null), bookId: 9, bookFolder: '/lib/Book', log: makeLog(), onFailure });
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('omitting it is a no-op — the failing arm still returns the same string outcome', async () => {
      writeFileMock.mockRejectedValueOnce(new Error('EACCES'));
      const outcome = await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log: makeLog() });
      expect(outcome).toBe('failed');
    });

    it('keeps the existing warn line unchanged in level and content (AC14)', async () => {
      writeFileMock.mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
      const log = makeLog();

      await writeOpfSidecar({ enabled: true, bookService: makeBookService(makeBook()), bookId: 1, bookFolder: '/lib/Book', log, onFailure: vi.fn() });

      expect(log.warn).toHaveBeenCalledWith(
        { error: { message: 'EACCES: permission denied', stack: expect.any(String), type: 'Error', code: 'EACCES' }, bookId: 1 },
        'Failed to write metadata.opf — continuing',
      );
      expect(log.error).not.toHaveBeenCalled();
    });
  });
});
