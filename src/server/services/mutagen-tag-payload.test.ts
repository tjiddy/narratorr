import { describe, it, expect } from 'vitest';
import {
  buildMutagenRequest,
  mutagenFormatForExtension,
  coverMimeForPath,
  COVER_MIME_BY_EXTENSION,
  TAGGABLE_EXTENSIONS,
  MP4_TAG_ATOMS,
  ID3_TAG_FRAMES,
  type MutagenTagOp,
} from './mutagen-tag-payload.js';
import { SIMPLE_EXCLUDABLE_FIELDS } from './retag-plan.js';
import type { TagMetadata } from './tagging.service.js';

const FULL_TAGS: TagMetadata = {
  artist: 'Brandon Sanderson',
  albumArtist: 'Brandon Sanderson',
  album: 'Words of Radiance',
  title: 'Words of Radiance',
  composer: 'Michael Kramer',
  grouping: 'The Stormlight Archive',
  series: 'The Stormlight Archive',
  seriesPart: 2,
  subtitle: 'Book Two',
  asin: 'B00ABCDEFG',
  publisher: 'Tor Books',
  description: 'An epic fantasy.',
  date: '2014',
  genre: 'Fantasy',
  track: 1,
  trackTotal: 3,
};

function opsFor(format: 'mp4' | 'id3', tags: TagMetadata, coverPath?: string) {
  return buildMutagenRequest({ filePath: `/books/book.${format === 'mp4' ? 'm4b' : 'mp3'}`, format, tags, ...(coverPath && { coverPath }) });
}

function keyed(ops: MutagenTagOp[]): Record<string, string> {
  return Object.fromEntries(ops.map(op => [op.key, op.value]));
}

describe('per-format mapping-table parity (#1697 DRY-3, #2210 AC18)', () => {
  // Preview and apply cannot drift only while every diffable string field has a write mapping in
  // BOTH tables. Numeric seriesPart/track are handled separately, as they always were.
  it.each([
    ['MP4_TAG_ATOMS', MP4_TAG_ATOMS],
    ['ID3_TAG_FRAMES', ID3_TAG_FRAMES],
  ])('%s field-key set equals SIMPLE_EXCLUDABLE_FIELDS', (_name, table) => {
    expect(new Set(table.map(([field]) => field))).toEqual(new Set(SIMPLE_EXCLUDABLE_FIELDS));
  });

  it.each([
    ['MP4_TAG_ATOMS', MP4_TAG_ATOMS],
    ['ID3_TAG_FRAMES', ID3_TAG_FRAMES],
  ])('%s maps every field to a distinct key', (_name, table) => {
    expect(new Set(table.map(([, key]) => key)).size).toBe(table.length);
  });
});

describe('buildMutagenRequest — MP4', () => {
  it('produces the exact atom map for a full tag set', () => {
    const { request } = opsFor('mp4', FULL_TAGS);

    expect(keyed(request.ops)).toEqual({
      '©ART': 'Brandon Sanderson',
      'aART': 'Brandon Sanderson',
      '©alb': 'Words of Radiance',
      '©nam': 'Words of Radiance',
      '©wrt': 'Michael Kramer',
      '©grp': 'The Stormlight Archive',
      '©gen': 'Fantasy',
      '©day': '2014',
      'desc': 'An epic fantasy.',
      '----:com.apple.iTunes:SUBTITLE': 'Book Two',
      '----:com.apple.iTunes:ASIN': 'B00ABCDEFG',
      '----:com.apple.iTunes:PUBLISHER': 'Tor Books',
      '----:com.apple.iTunes:SERIES': 'The Stormlight Archive',
      '©mvn': 'The Stormlight Archive',
      '©mvi': '2',
      '----:com.apple.iTunes:SERIES-PART': '2',
      'trkn': '1/3',
    });
  });

  it('tags the freeform atoms as freeform and the movement index as int', () => {
    const { request } = opsFor('mp4', FULL_TAGS);
    const byKey = new Map(request.ops.map(op => [op.key, op.kind]));

    expect(byKey.get('----:com.apple.iTunes:ASIN')).toBe('freeform');
    expect(byKey.get('©mvi')).toBe('int');
    expect(byKey.get('trkn')).toBe('pair');
    expect(byKey.get('©nam')).toBe('text');
  });

  it('the four fields ffmpeg silently dropped on M4B are all present', () => {
    const { request } = opsFor('mp4', FULL_TAGS);
    const keys = new Set(request.ops.map(op => op.key));

    for (const key of [
      '----:com.apple.iTunes:SERIES',
      '----:com.apple.iTunes:SUBTITLE',
      '----:com.apple.iTunes:ASIN',
      '----:com.apple.iTunes:PUBLISHER',
    ]) {
      expect(keys).toContain(key);
    }
  });

  it('never writes ©mvc — the series book count is not on the retag input (D3)', () => {
    const { request } = opsFor('mp4', FULL_TAGS);
    expect(request.ops.map(op => op.key)).not.toContain('©mvc');
  });
});

describe('buildMutagenRequest — ID3', () => {
  it('produces the exact frame map for a full tag set', () => {
    const { request } = opsFor('id3', FULL_TAGS);

    expect(keyed(request.ops)).toEqual({
      'TPE1': 'Brandon Sanderson',
      'TPE2': 'Brandon Sanderson',
      'TALB': 'Words of Radiance',
      'TIT2': 'Words of Radiance',
      'TCOM': 'Michael Kramer',
      'TIT1': 'The Stormlight Archive',
      'TCON': 'Fantasy',
      'TDRC': '2014',
      'TDES': 'An epic fantasy.',
      'TIT3': 'Book Two',
      'TXXX:ASIN': 'B00ABCDEFG',
      'TPUB': 'Tor Books',
      'TXXX:series': 'The Stormlight Archive',
      'MVNM': 'The Stormlight Archive',
      'MVIN': '2',
      'TXXX:series-part': '2',
      'TRCK': '1/3',
    });
  });

  it('writes genuine MVNM/MVIN frames, not TXXX freeform only (AC5)', () => {
    const { request } = opsFor('id3', FULL_TAGS);
    const byKey = new Map(request.ops.map(op => [op.key, op.kind]));

    expect(byKey.get('MVNM')).toBe('text');
    expect(byKey.get('MVIN')).toBe('text');
    expect(byKey.get('TXXX:series')).toBe('freeform');
  });
});

describe('buildMutagenRequest — series position boundaries', () => {
  it('writes ©mvi = 0 for position zero (!= null, not truthy)', () => {
    const { request } = opsFor('mp4', { album: 'Book', series: 'S', seriesPart: 0 });
    expect(keyed(request.ops)['©mvi']).toBe('0');
    expect(keyed(request.ops)['----:com.apple.iTunes:SERIES-PART']).toBe('0');
  });

  it('omits ©mvi for a fractional position but keeps the lossless freeform (AC4)', () => {
    const { request } = opsFor('mp4', { album: 'Book', series: 'S', seriesPart: 2.5 });
    const keys = request.ops.map(op => op.key);

    expect(keys).not.toContain('©mvi');
    expect(keyed(request.ops)['----:com.apple.iTunes:SERIES-PART']).toBe('2.5');
    expect(keyed(request.ops)['©mvn']).toBe('S');
  });

  it('MVIN carries a fractional position exactly, because it is a text frame', () => {
    const { request } = opsFor('id3', { album: 'Book', series: 'S', seriesPart: 2.5 });
    expect(keyed(request.ops)['MVIN']).toBe('2.5');
    expect(keyed(request.ops)['TXXX:series-part']).toBe('2.5');
  });

  it.each(['mp4', 'id3'] as const)('%s writes no movement ops when seriesPosition is absent', (format) => {
    const { request } = opsFor(format, { album: 'Book', series: 'S' });
    const keys = request.ops.map(op => op.key);

    for (const key of ['©mvi', '----:com.apple.iTunes:SERIES-PART', 'MVIN', 'TXXX:series-part']) {
      expect(keys).not.toContain(key);
    }
  });

  it.each(['mp4', 'id3'] as const)('%s writes no series ops at all with no series', (format) => {
    const { request } = opsFor(format, { album: 'Book' });
    const keys = request.ops.map(op => op.key);

    for (const key of ['©mvn', 'MVNM', '----:com.apple.iTunes:SERIES', 'TXXX:series']) {
      expect(keys).not.toContain(key);
    }
  });
});

describe('buildMutagenRequest — track pairing and empty values', () => {
  it.each([
    ['track without trackTotal', { track: 1 }],
    ['trackTotal without track', { trackTotal: 3 }],
  ])('%s emits no half-written track op', (_name, partial) => {
    for (const format of ['mp4', 'id3'] as const) {
      const { request } = opsFor(format, { album: 'Book', ...partial });
      const keys = request.ops.map(op => op.key);
      expect(keys).not.toContain('trkn');
      expect(keys).not.toContain('TRCK');
    }
  });

  it('drops an empty-string value, matching the pre-mutagen truthy contract', () => {
    const { request } = opsFor('mp4', { album: 'Book', subtitle: '', asin: '' });
    const keys = request.ops.map(op => op.key);

    expect(keys).toContain('©alb');
    expect(keys).not.toContain('----:com.apple.iTunes:SUBTITLE');
    expect(keys).not.toContain('----:com.apple.iTunes:ASIN');
  });

  it('emits no ops at all for an empty tag set', () => {
    const { request, warnings } = opsFor('mp4', {});
    expect(request.ops).toEqual([]);
    expect(warnings).toEqual([]);
    expect(request.cover).toBeNull();
  });
});

describe('buildMutagenRequest — cover art (D4/AC10)', () => {
  it.each([
    ['/books/cover.jpg', 'image/jpeg'],
    ['/books/cover.jpeg', 'image/jpeg'],
    ['/books/cover.PNG', 'image/png'],
  ])('derives the mime for %s', (coverPath, mime) => {
    const { request, warnings } = opsFor('mp4', { album: 'Book' }, coverPath);
    expect(request.cover).toEqual({ path: coverPath, mime });
    expect(warnings).toEqual([]);
  });

  it('warns and still writes the tags for a .webp cover', () => {
    const { request, warnings } = opsFor('mp4', { album: 'Book' }, '/books/cover.webp');

    expect(request.cover).toBeNull();
    expect(warnings).toEqual(['Cover art format not supported for embedding: .webp']);
    // The other fields survive — the ffmpeg path used to fail the whole invocation.
    expect(request.ops.map(op => op.key)).toContain('©alb');
  });

  it('leaves cover null when no cover path is supplied', () => {
    const { request } = opsFor('id3', { album: 'Book' });
    expect(request.cover).toBeNull();
  });
});

describe('coverMimeForPath (#2214)', () => {
  it.each([
    ['/books/cover.jpg', 'image/jpeg'],
    ['/books/cover.jpeg', 'image/jpeg'],
    ['/books/cover.png', 'image/png'],
    ['/books/Cover.JPG', 'image/jpeg'],
    ['/books/COVER.PNG', 'image/png'],
  ])('%s → %s', (filePath, mime) => {
    expect(coverMimeForPath(filePath)).toBe(mime);
  });

  it.each([
    ['/books/cover.webp'],
    ['/books/cover.gif'],
    ['/books/cover'],
  ])('%s has no embeddable mime', (filePath) => {
    expect(coverMimeForPath(filePath)).toBeUndefined();
  });

  // The tagging picker tiers candidates on this helper, so the table it reads is the one
  // buildMutagenRequest consults — not a second list that can drift from it.
  it('answers for every extension in the exported table', () => {
    for (const [ext, mime] of Object.entries(COVER_MIME_BY_EXTENSION)) {
      expect(coverMimeForPath(`/books/cover${ext}`)).toBe(mime);
      expect(opsFor('mp4', { album: 'Book' }, `/books/cover${ext}`).request.cover)
        .toEqual({ path: `/books/cover${ext}`, mime });
    }
  });
});

describe('TAGGABLE_EXTENSIONS', () => {
  // A file the directory scan collects but the per-file branch cannot type would report `skipped`
  // on every retag, so the set and the branch must stay one source of truth.
  it('contains exactly the extensions mutagenFormatForExtension can type', () => {
    for (const ext of TAGGABLE_EXTENSIONS) {
      expect(mutagenFormatForExtension(ext)).not.toBeNull();
    }
    expect([...TAGGABLE_EXTENSIONS].sort()).toEqual(['.m4a', '.m4b', '.mp3', '.mp4']);
  });
});

describe('mutagenFormatForExtension', () => {
  it.each([
    ['.mp3', 'id3'],
    ['.m4a', 'mp4'],
    ['.m4b', 'mp4'],
    ['.mp4', 'mp4'],
  ])('%s → %s', (ext, format) => {
    expect(mutagenFormatForExtension(ext)).toBe(format);
  });

  it.each(['.ogg', '.flac', '.wav', ''])('returns null for %j', (ext) => {
    expect(mutagenFormatForExtension(ext)).toBeNull();
  });
});
