import { describe, it, expect } from 'vitest';
import { parseOpf, parseOpfWithDiagnostics } from './opf-reader.js';
import { generateOpf } from './opf-writer.js';
import type { BookWithAuthor } from '../services/book.service.js';

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

describe('parseOpf — round-trip against generateOpf (AC14)', () => {
  // Multiple creator roles, entity-heavy text, and position zero force the round-trip branches.
  const book = makeBook({
    title: 'Tiamat & the Wrath',
    subtitle: 'Book <Nine> of "The Expanse"',
    authors: [{ name: 'James S. A. Corey' }, { name: 'Ty Franck' }] as BookWithAuthor['authors'],
    narrators: [{ name: 'Jefferson Mays' }, { name: "Erin O'Brien" }] as BookWithAuthor['narrators'],
    description: 'Ships & stations <b>collide</b> — "the gate" won\'t hold.',
    publisher: 'Orbit & Co.',
    publishedDate: '2019-03-26',
    asin: 'B07HFB6L9L',
    isbn: '9780316332873',
    seriesName: 'The Expanse',
    seriesPosition: 0,
    genres: ['Science Fiction', 'Space Opera'],
  });

  const parsed = parseOpf(generateOpf(book));

  it('recovers every field the writer emitted', () => {
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      title: 'Tiamat & the Wrath',
      subtitle: 'Book <Nine> of "The Expanse"',
      authors: ['James S. A. Corey', 'Ty Franck'],
      narrators: ['Jefferson Mays', "Erin O'Brien"],
      description: 'Ships & stations <b>collide</b> — "the gate" won\'t hold.',
      publisher: 'Orbit & Co.',
      publishedDate: '2019-03-26',
      asin: 'B07HFB6L9L',
      isbn: '9780316332873',
      seriesName: 'The Expanse',
      seriesPosition: 0,
      genres: ['Science Fiction', 'Space Opera'],
    });
  });

  it('keeps authors and narrators in separate buckets (reds if the role filter is dropped)', () => {
    expect(parsed!.authors).not.toContain('Jefferson Mays');
    expect(parsed!.narrators).not.toContain('James S. A. Corey');
  });
});

describe('parseOpf — seriesPosition boundary table (AC4)', () => {
  const series = (content: string): string =>
    `<meta name="calibre:series" content="Foo"/><meta name="calibre:series_index" content="${content}"/>`;

  it.each([
    ['0', 0],
    ['1.5', 1.5],
    ['', null],
    ['   ', null],
    ['abc', null],
  ])('content=%j → %j', (content, expected) => {
    expect(parseOpf(rawOpf(series(content)))?.seriesPosition).toBe(expected);
  });

  it('a present series with no index element yields name set, position null', () => {
    const parsed = parseOpf(rawOpf('<meta name="calibre:series" content="Foo"/>'));
    expect(parsed).toMatchObject({ seriesName: 'Foo', seriesPosition: null });
  });
});

describe('parseOpf — role attribute shapes (AC3)', () => {
  it.each([
    ['opf:role', 'nrt', 'narrators'],
    ['role', 'nrt', 'narrators'],
    ['xyz:role', 'nrt', 'narrators'],
    ['role', 'NRT', 'narrators'],
    ['opf:role', 'aut', 'authors'],
    ['role', 'AUT', 'authors'],
  ] as const)('%s="%s" buckets into %s', (attr, value, bucket) => {
    const parsed = parseOpf(rawOpf(`<dc:creator ${attr}="${value}">Pat Q</dc:creator>`));
    expect(parsed?.[bucket]).toEqual(['Pat Q']);
  });

  it('a role-less dc:creator is an author (the Calibre convention)', () => {
    const parsed = parseOpf(rawOpf('<dc:creator>Pat Q</dc:creator>'));
    expect(parsed).toMatchObject({ authors: ['Pat Q'], narrators: [] });
  });

  it('an unrecognised role is ignored entirely', () => {
    const parsed = parseOpf(rawOpf('<dc:creator opf:role="edt">Pat Q</dc:creator><dc:title>T</dc:title>'));
    expect(parsed).toMatchObject({ authors: [], narrators: [], title: 'T' });
  });

  it('element local names are CASE-SENSITIVE — <DC:TITLE> does not match title', () => {
    const parsed = parseOpf(rawOpf('<DC:TITLE>Shouty</DC:TITLE><dc:publisher>P</dc:publisher>'));
    expect(parsed).toMatchObject({ title: null, publisher: 'P' });
  });
});

describe('parseOpf — attribute whitespace (AC5)', () => {
  // htmlparser2 leaves raw attribute whitespace for the reader to trim.
  it('trims raw tabs and newlines out of a meta content value', () => {
    const parsed = parseOpf(rawOpf('<meta name="calibre:series" content="\t Foo\n Bar \n"/>'));
    expect(parsed?.seriesName).toBe('Foo\n Bar');
  });

  it('trims a raw newline out of a meta name value', () => {
    const parsed = parseOpf(rawOpf('<meta name="\ncalibre:series\t" content="Foo"/>'));
    expect(parsed?.seriesName).toBe('Foo');
  });
});

describe('parseOpf — rejection table (AC2)', () => {
  it.each([
    ['an empty string', ''],
    ['non-XML bytes', 'not xml at all'],
    ['an HTML document', '<!doctype html><html><head><title>Hi</title></head><body>x</body></html>'],
    ['a <container> root', '<?xml version="1.0"?><container><rootfiles/></container>'],
    ['two element roots', '<package><metadata><dc:title>A</dc:title></metadata></package><package/>'],
    ['a package with an empty metadata', '<package><metadata></metadata></package>'],
    ['a package whose metadata holds only unrecognised elements', rawOpf('<dc:language>en</dc:language><foo:bar>x</foo:bar>')],
    ['a package with no metadata element at all', '<package><manifest/></package>'],
    ['a metadata holding only whitespace-valued elements', rawOpf('<dc:title>   </dc:title><dc:creator>  </dc:creator>')],
  ])('%s returns exactly null', (_label, xml) => {
    // An all-null OpfMetadata is not a permitted result.
    expect(parseOpf(xml)).toBeNull();
  });

  it('never throws on any rejection row', () => {
    for (const xml of ['', '\x00\x01\x02', '<package', '<package><metadata><dc:title>unclosed</metadata>']) {
      expect(() => parseOpf(xml)).not.toThrow();
    }
  });
});

describe('parseOpf — metadata scoping (AC3 / F4)', () => {
  it('reads only the first <metadata>\'s DIRECT children', () => {
    const xml = [
      '<package version="2.0">',
      '  <guide><dc:title>Guide Title</dc:title></guide>',
      '  <metadata>',
      '    <wrapper><dc:title>Nested Title</dc:title></wrapper>',
      '    <dc:title>Real Title</dc:title>',
      '  </metadata>',
      '  <metadata><dc:title>Second Metadata Title</dc:title></metadata>',
      '</package>',
    ].join('\n');
    expect(parseOpf(xml)?.title).toBe('Real Title');
  });

  it('a title that exists ONLY outside the first metadata is invisible', () => {
    const xml = [
      '<package version="2.0">',
      '  <guide><dc:title>Guide Title</dc:title></guide>',
      '  <metadata><dc:publisher>P</dc:publisher></metadata>',
      '</package>',
    ].join('\n');
    expect(parseOpf(xml)).toMatchObject({ title: null, publisher: 'P' });
  });
});

describe('parseOpf — repeated scalars (AC3 / F4)', () => {
  it('takes the first value of each repeated scalar', () => {
    const parsed = parseOpf(rawOpf([
      '<dc:title>First Title</dc:title><dc:title>Second Title</dc:title>',
      '<dc:publisher>First Pub</dc:publisher><dc:publisher>Second Pub</dc:publisher>',
      '<dc:date>1999-01-01</dc:date><dc:date>2020-02-02</dc:date>',
      '<dc:description>First Desc</dc:description><dc:description>Second Desc</dc:description>',
    ].join('')));
    expect(parsed).toMatchObject({
      title: 'First Title', publisher: 'First Pub', publishedDate: '1999-01-01', description: 'First Desc',
    });
  });

  it('an empty earlier element does not shadow a later populated one (usable, not merely first)', () => {
    const parsed = parseOpf(rawOpf('<dc:title></dc:title><dc:title>Populated</dc:title>'));
    expect(parsed?.title).toBe('Populated');
  });
});

describe('parseOpf — repeated identifiers (AC3 / F4)', () => {
  it('takes the first of two same-scheme identifiers', () => {
    const parsed = parseOpf(rawOpf(
      '<dc:identifier opf:scheme="ASIN">B00000001</dc:identifier><dc:identifier opf:scheme="ASIN">B00000002</dc:identifier>',
    ));
    expect(parsed?.asin).toBe('B00000001');
  });

  it('resolves interleaved ASIN and ISBN independently', () => {
    const parsed = parseOpf(rawOpf([
      '<dc:identifier opf:scheme="ISBN">978000000001</dc:identifier>',
      '<dc:identifier opf:scheme="ASIN">B00000001</dc:identifier>',
      '<dc:identifier opf:scheme="ISBN">978000000002</dc:identifier>',
    ].join('')));
    expect(parsed).toMatchObject({ asin: 'B00000001', isbn: '978000000001' });
  });

  it('matches a lowercase scheme value', () => {
    expect(parseOpf(rawOpf('<dc:identifier scheme="asin">B00000001</dc:identifier>'))?.asin).toBe('B00000001');
  });
});

describe('parseOpf — series pairing (AC3 / F4)', () => {
  it('(a) pairs an adjacent series + index', () => {
    const parsed = parseOpf(rawOpf(
      '<meta name="calibre:series" content="Alpha"/><meta name="calibre:series_index" content="3"/>',
    ));
    expect(parsed).toMatchObject({ seriesName: 'Alpha', seriesPosition: 3 });
  });

  it('(b) with two series blocks takes the FIRST series and ITS index, never the second\'s', () => {
    const parsed = parseOpf(rawOpf([
      '<meta name="calibre:series" content="Alpha"/><meta name="calibre:series_index" content="3"/>',
      '<meta name="calibre:series" content="Beta"/><meta name="calibre:series_index" content="9"/>',
    ].join('')));
    expect(parsed).toMatchObject({ seriesName: 'Alpha', seriesPosition: 3 });
  });

  it('(c) falls back to a non-adjacent index when exactly one series is present', () => {
    const parsed = parseOpf(rawOpf([
      '<meta name="calibre:series" content="Alpha"/>',
      '<dc:subject>Fantasy</dc:subject>',
      '<meta name="calibre:series_index" content="7"/>',
    ].join('')));
    expect(parsed).toMatchObject({ seriesName: 'Alpha', seriesPosition: 7 });
  });

  it('(d) with two series and a single non-adjacent index the position is null', () => {
    const parsed = parseOpf(rawOpf([
      '<meta name="calibre:series" content="Alpha"/>',
      '<meta name="calibre:series" content="Beta"/>',
      '<meta name="calibre:series_index" content="7"/>',
    ].join('')));
    expect(parsed).toMatchObject({ seriesName: 'Alpha', seriesPosition: null });
  });
});

describe('parseOpf — bounds (AC5)', () => {
  it('truncates a 20 000-char description to 8 000', () => {
    const parsed = parseOpf(rawOpf(`<dc:description>${'d'.repeat(20_000)}</dc:description>`));
    expect(parsed?.description).toHaveLength(8_000);
  });

  it('truncates a 2 000-char title to 512', () => {
    const parsed = parseOpf(rawOpf(`<dc:title>${'t'.repeat(2_000)}</dc:title>`));
    expect(parsed?.title).toHaveLength(512);
  });

  it('caps 200 dc:subject elements at 64', () => {
    const subjects = Array.from({ length: 200 }, (_, i) => `<dc:subject>Genre ${i}</dc:subject>`).join('');
    expect(parseOpf(rawOpf(subjects))?.genres).toHaveLength(64);
  });

  it.each(['ASIN', 'ISBN'] as const)('keeps a 64-char %s verbatim', (scheme) => {
    const value = 'x'.repeat(64);
    const parsed = parseOpf(rawOpf(`<dc:identifier opf:scheme="${scheme}">${value}</dc:identifier>`));
    expect(parsed?.[scheme.toLowerCase() as 'asin' | 'isbn']).toBe(value);
  });

  it.each(['ASIN', 'ISBN'] as const)('drops a lone 65-char %s rather than truncating it', (scheme) => {
    const parsed = parseOpf(rawOpf([
      `<dc:identifier opf:scheme="${scheme}">${'x'.repeat(65)}</dc:identifier>`,
      '<dc:title>Anchor</dc:title>',
    ].join('')));
    expect(parsed?.[scheme.toLowerCase() as 'asin' | 'isbn']).toBeNull();
  });
});

describe('parseOpf — pipeline order (AC5, test 10a)', () => {
  it.each(['ASIN', 'ISBN'] as const)('an over-bound %s does not consume the slot from a later valid one', (scheme) => {
    const parsed = parseOpf(rawOpf([
      `<dc:identifier opf:scheme="${scheme}">${'x'.repeat(65)}</dc:identifier>`,
      `<dc:identifier opf:scheme="${scheme}">B07HFB6L9L</dc:identifier>`,
    ].join('')));
    expect(parsed?.[scheme.toLowerCase() as 'asin' | 'isbn']).toBe('B07HFB6L9L');
  });

  it('an over-bound scalar still wins its slot, truncated — the deliberate scalar/identifier asymmetry', () => {
    const parsed = parseOpf(rawOpf([
      `<dc:title>${'a'.repeat(600)}</dc:title>`,
      '<dc:title>Short Second Title</dc:title>',
    ].join('')));
    expect(parsed?.title).toBe('a'.repeat(512));
  });

  it('truncates BEFORE deduplicating — two creators sharing 512 chars collapse to one', () => {
    const shared = 'a'.repeat(512);
    const parsed = parseOpf(rawOpf([
      `<dc:creator opf:role="aut">${shared}FIRST</dc:creator>`,
      `<dc:creator opf:role="aut">${shared}SECOND</dc:creator>`,
    ].join('')));
    expect(parsed?.authors).toEqual([shared]);
  });

  it('deduplicates BEFORE capping — 64 identical genres plus one unique yields two', () => {
    const subjects = `${'<dc:subject>Same</dc:subject>'.repeat(64)}<dc:subject>Different</dc:subject>`;
    expect(parseOpf(rawOpf(subjects))?.genres).toEqual(['Same', 'Different']);
  });
});

describe('parseOpfWithDiagnostics (AC1 / AC5, test 10b)', () => {
  it('reports a truncated description', () => {
    const { diagnostics } = parseOpfWithDiagnostics(rawOpf(`<dc:description>${'d'.repeat(20_000)}</dc:description>`));
    expect(diagnostics).toContainEqual({ field: 'description', kind: 'truncated' });
  });

  it('reports a capped genre array', () => {
    const subjects = Array.from({ length: 200 }, (_, i) => `<dc:subject>Genre ${i}</dc:subject>`).join('');
    expect(parseOpfWithDiagnostics(rawOpf(subjects)).diagnostics).toContainEqual({ field: 'genres', kind: 'capped' });
  });

  it('reports a dropped over-bound ASIN', () => {
    const { diagnostics } = parseOpfWithDiagnostics(rawOpf([
      `<dc:identifier opf:scheme="ASIN">${'x'.repeat(65)}</dc:identifier>`,
      '<dc:title>Anchor</dc:title>',
    ].join('')));
    expect(diagnostics).toContainEqual({ field: 'asin', kind: 'dropped-over-bound' });
  });

  it('carries no field VALUES — an 8 000-char description must never reach a log line', () => {
    const { diagnostics } = parseOpfWithDiagnostics(rawOpf(`<dc:description>${'d'.repeat(20_000)}</dc:description>`));
    for (const diagnostic of diagnostics) {
      expect(Object.keys(diagnostic).sort()).toEqual(['field', 'kind']);
      expect(JSON.stringify(diagnostic)).not.toContain('dddd');
    }
  });

  it('emits no diagnostics for an in-bounds document, and parseOpf takes no logger', () => {
    const xml = rawOpf('<dc:title>Fine</dc:title>');
    expect(parseOpfWithDiagnostics(xml).diagnostics).toEqual([]);
    expect(parseOpf(xml)?.title).toBe('Fine');
  });
});

describe('parseOpf — XXE and entity-expansion fixtures, kept permanently (D6)', () => {
  // Exact literal references pin htmlparser2's no-DTD/no-entity behavior against future parser swaps.
  it.each([
    [
      'a SYSTEM file entity',
      '<!DOCTYPE package [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
      '&xxe;',
    ],
    [
      'a parameter entity that declares a general entity',
      `<!DOCTYPE package [<!ENTITY % pe "<!ENTITY leaked 'expanded'>">%pe;]>`,
      '&leaked;',
    ],
  ])('leaves %s literal and unexpanded', (_label, doctype, reference) => {
    const xml = [
      '<?xml version="1.0"?>',
      doctype,
      `<package version="2.0"><metadata><dc:title>${reference}</dc:title></metadata></package>`,
    ].join('\n');

    expect(parseOpf(xml)?.title).toBe(reference);
  });

  it('leaves a billion-laughs reference literal, and terminates promptly', () => {
    const entities = Array.from({ length: 9 }, (_, i) =>
      i === 0
        ? '<!ENTITY lol "lol">'
        : `<!ENTITY lol${i} "&lol${i - 1};&lol${i - 1};&lol${i - 1};&lol${i - 1};&lol${i - 1};&lol${i - 1};&lol${i - 1};&lol${i - 1};&lol${i - 1};&lol${i - 1};">`,
    ).join('');
    const xml = [
      '<?xml version="1.0"?>',
      `<!DOCTYPE package [${entities}]>`,
      '<package version="2.0"><metadata><dc:title>&lol8;</dc:title></metadata></package>',
    ].join('\n');

    const started = process.hrtime.bigint();
    const parsed = parseOpf(xml);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(parsed?.title).toBe('&lol8;');
    // Separately bound liveness in case a future parser fully expands the payload.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

describe('parseOpf — foreign (unmarked) sidecar (D5)', () => {
  it('parses a hand-written ABS/Calibre-style metadata.opf with no narratorr marker', () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uuid_id">',
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
      '    <dc:title>Calibre Book</dc:title>',
      '    <dc:creator opf:file-as="Author, An" opf:role="aut">An Author</dc:creator>',
      '    <dc:creator opf:role="nrt">A Narrator</dc:creator>',
      '    <dc:description>&lt;p&gt;Blurb&lt;/p&gt;</dc:description>',
      '    <dc:publisher>Calibre Press</dc:publisher>',
      '    <dc:date>2021-05-04T00:00:00+00:00</dc:date>',
      '    <dc:language>eng</dc:language>',
      '    <dc:identifier opf:scheme="ISBN">9781234567897</dc:identifier>',
      '    <dc:subject>Fiction</dc:subject>',
      '    <meta name="calibre:series" content="Calibre Series"/>',
      '    <meta name="calibre:series_index" content="2.0"/>',
      '  </metadata>',
      '</package>',
    ].join('\n');
    expect(parseOpf(xml)).toEqual({
      title: 'Calibre Book',
      subtitle: null,
      authors: ['An Author'],
      narrators: ['A Narrator'],
      description: '<p>Blurb</p>',
      publisher: 'Calibre Press',
      publishedDate: '2021-05-04T00:00:00+00:00',
      asin: null,
      isbn: '9781234567897',
      seriesName: 'Calibre Series',
      seriesPosition: 2,
      genres: ['Fiction'],
    });
  });
});
