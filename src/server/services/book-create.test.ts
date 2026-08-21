import { describe, it, expect } from 'vitest';
import { buildNewBookValues } from './book-create.js';

describe('buildNewBookValues — litRPG marker inference (#2535)', () => {
  const BASE = { title: 'Untitled', authors: [{ name: 'Author' }] };

  it('adds the inferred genre when the title carries a marker and the book has none', () => {
    const values = buildNewBookValues({ ...BASE, title: 'Mage Tank 2: A LitRPG Adventure' }, null);

    expect(values.genres).toEqual(['LitRPG']);
  });

  it('appends the inferred genre after provider genres, preserving their order', () => {
    const values = buildNewBookValues(
      {
        ...BASE,
        title: 'The Land: Founding',
        subtitle: 'A LitRPG Saga (Chaos Seeds, Book 1)',
        genres: ['Humor', 'Fantasy', 'Action & Adventure', 'Epic Fantasy', 'Satire'],
      },
      null,
    );

    expect(values.genres).toEqual(['Humor', 'Fantasy', 'Action & Adventure', 'Epic Fantasy', 'Satire', 'LitRPG']);
  });

  it('reads a marker carried only by the series name', () => {
    const values = buildNewBookValues({ ...BASE, title: 'Book Two', seriesName: 'Chrysalis: A GameLit Saga' }, null);

    expect(values.genres).toEqual(['GameLit']);
  });

  it('does not duplicate a genre the provider already supplied', () => {
    const values = buildNewBookValues(
      { ...BASE, title: 'A LitRPG Adventure', genres: ['litrpg', 'Fantasy'] },
      null,
    );

    expect(values.genres).toEqual(['litrpg', 'Fantasy']);
  });

  // AC16: an unmarked create must be indistinguishable from the pre-#2535 payload, and an absent
  // genres value must stay absent — `recomputeClearedFields` reads `[]` as an operator clear.
  it('leaves an unmarked create byte-identical, with undefined staying undefined', () => {
    const undefinedGenres = buildNewBookValues({ ...BASE, title: 'Dungeon Crawler Carl' }, null);
    expect(undefinedGenres.genres).toBeUndefined();
    expect('genres' in undefinedGenres).toBe(true);

    const provided = ['Fantasy', 'Humor'];
    const withGenres = buildNewBookValues({ ...BASE, title: 'Dungeon Crawler Carl', genres: provided }, null);
    expect(withGenres.genres).toEqual(provided);
  });

  it('leaves every other column untouched by the inference', () => {
    const values = buildNewBookValues(
      { ...BASE, title: 'A LitRPG Adventure', subtitle: 'Sub', seriesName: 'Series', seriesPosition: 3 },
      'B0LITRPG01',
    );

    expect(values).toMatchObject({
      title: 'A LitRPG Adventure',
      subtitle: 'Sub',
      seriesName: 'Series',
      seriesPosition: 3,
      asin: 'B0LITRPG01',
      status: 'wanted',
    });
  });
});
