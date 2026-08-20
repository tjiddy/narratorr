import { describe, it, expect } from 'vitest';
import { buildTagProjection } from './tag-projection.js';
import { buildCanonicalTags } from '../services/retag-plan.js';

/** A hydrated `BookService.getById` row, trimmed to the fields the projection reads. */
const row = (overrides: Record<string, unknown> = {}) => ({
  title: 'The Way of Kings',
  authors: [{ name: 'Brandon Sanderson' }],
  narrators: [{ name: 'Michael Kramer' }],
  seriesName: 'The Stormlight Archive',
  seriesPosition: 1,
  asin: 'B00ABCDEFG',
  subtitle: 'Book One',
  description: 'An epic fantasy.',
  publisher: 'Tor Books',
  publishedDate: '2010-08-31',
  genres: ['Fantasy'],
  coverUrl: '/covers/1.jpg',
  ...overrides,
});

describe('buildTagProjection', () => {
  it('joins every author with ", " and every narrator with ", "', () => {
    const projection = buildTagProjection(row({
      authors: [{ name: 'Brandon Sanderson' }, { name: 'Co Author' }],
      narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
    }));

    expect(projection.authorName).toBe('Brandon Sanderson, Co Author');
    expect(projection.narrator).toBe('Michael Kramer, Kate Reading');
    // The delimiter is part of the contract this re-homes from ImportContext.narratorStr.
    expect(projection.narrator).not.toContain(';');
  });

  it('emits a single author or narrator undecorated', () => {
    const projection = buildTagProjection(row());

    expect(projection.authorName).toBe('Brandon Sanderson');
    expect(projection.narrator).toBe('Michael Kramer');
  });

  it('yields null — never an empty string — for zero authors and zero narrators', () => {
    const projection = buildTagProjection(row({ authors: [], narrators: [] }));

    expect(projection.authorName).toBeNull();
    expect(projection.narrator).toBeNull();
  });

  // `||` here would drop a legitimate position-zero prequel; buildCanonicalTags guards with `!= null`.
  it('preserves seriesPosition 0 and passes a null position through unchanged', () => {
    expect(buildTagProjection(row({ seriesPosition: 0 })).seriesPosition).toBe(0);
    expect(buildTagProjection(row({ seriesPosition: null })).seriesPosition).toBeNull();

    expect(buildCanonicalTags(buildTagProjection(row({ seriesPosition: 0 })))).toMatchObject({ seriesPart: 0 });
  });

  it.each([
    ['null', null, null],
    ['empty', [], []],
    ['populated', ['Fantasy'], ['Fantasy']],
  ])('forwards %s genres verbatim', (_label, genres, expected) => {
    expect(buildTagProjection(row({ genres })).genres).toEqual(expected);
  });

  it.each([
    ['null', null],
    ['empty', []],
  ])('produces no genre tag downstream when genres are %s', (_label, genres) => {
    expect(buildCanonicalTags(buildTagProjection(row({ genres })))).not.toHaveProperty('genre');
  });

  it('forwards every absent optional field as undefined without throwing', () => {
    const bare = { title: 'Bare', authors: [], narrators: [] };

    expect(() => buildTagProjection(bare)).not.toThrow();
    const projection = buildTagProjection(bare);
    expect(projection.asin).toBeUndefined();
    expect(projection.subtitle).toBeUndefined();
    expect(projection.description).toBeUndefined();
    expect(projection.publisher).toBeUndefined();
    expect(projection.publishedDate).toBeUndefined();
    expect(projection.coverUrl).toBeUndefined();
    expect(projection.seriesName).toBeUndefined();
    expect(projection.genres).toBeUndefined();
  });

  it('forwards every explicitly-null optional field as null', () => {
    const projection = buildTagProjection(row({
      seriesName: null, seriesPosition: null, asin: null, subtitle: null,
      description: null, publisher: null, publishedDate: null, genres: null, coverUrl: null,
    }));

    expect(projection).toEqual({
      title: 'The Way of Kings',
      authorName: 'Brandon Sanderson',
      narrator: 'Michael Kramer',
      seriesName: null, seriesPosition: null, asin: null, subtitle: null,
      description: null, publisher: null, publishedDate: null, genres: null, coverUrl: null,
    });
  });

  // Frozen literal, not a re-derivation: the retag and import paths now share this one builder, so a
  // symmetric mutation inside it would move both sides together and observe nothing.
  it('reproduces the shape retagBookWithinAdmissionLock and planRetag each spelled inline', () => {
    expect(buildTagProjection(row())).toEqual({
      title: 'The Way of Kings',
      authorName: 'Brandon Sanderson',
      narrator: 'Michael Kramer',
      seriesName: 'The Stormlight Archive',
      seriesPosition: 1,
      asin: 'B00ABCDEFG',
      subtitle: 'Book One',
      description: 'An epic fantasy.',
      publisher: 'Tor Books',
      publishedDate: '2010-08-31',
      genres: ['Fantasy'],
      coverUrl: '/covers/1.jpg',
    });
  });

  // Strict on purpose: production `getById` always hydrates both arrays, so a row without them is a
  // stale test double, and the throw is what exposes it (AC7 contains the blast radius).
  it('throws on a row missing the hydrated author/narrator arrays', () => {
    expect(() => buildTagProjection({ title: 'Partial' } as never)).toThrow();
  });
});
