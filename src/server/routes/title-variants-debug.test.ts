import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import { titleVariantsDebugResponseSchema } from '@shared/schemas.js';
import { explainTitlePairing } from '../services/series-title-match.js';

/**
 * Spy-wrap the real pairing rule: behavioral fixtures cannot distinguish delegation from an
 * inline copy. The route imports this separate module, so the mock intercepts it.
 */
vi.mock('../services/series-title-match.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/series-title-match.js')>();
  return { ...actual, explainTitlePairing: vi.fn(actual.explainTitlePairing) };
});

// No auth assertions: createTestApp omits authPlugin, so they would pass vacuously.
describe('POST /api/series/title-variants-debug', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    app = await createTestApp(createMockServices());
  });

  afterAll(async () => {
    await app.close();
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/series/title-variants-debug', payload });
  }

  it('returns 200 with the full per-side shape conforming to the shared schema', async () => {
    const res = await post({ title: 'star wars: the high republic: Light of the Jedi (New Order Series)' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(true);
    expect(body.input).toBe('star wars: the high republic: Light of the Jedi (New Order Series)');
    expect(body.full).toBe('star wars the high republic light of the jedi new order series');
    expect(body.lossless).toBe('star wars the high republic light of the jedi new order series');
    expect(body.degenerateFull).toBe(false);
    expect(body.variants).toEqual([
      { raw: 'star wars the high republic light of the jedi new order series', tag: 'full', parensStripped: false, lossy: false },
      { raw: 'star wars the high republic light of the jedi', tag: 'full', parensStripped: true, lossy: false },
      { raw: 'star wars the high republic', tag: 'prefix(2)', parensStripped: true, lossy: false },
      { raw: 'the high republic light of the jedi', tag: 'suffix(2)', parensStripped: true, lossy: false },
      { raw: 'star wars light of the jedi', tag: 'first+last', parensStripped: true, lossy: false },
      { raw: 'star wars', tag: 'prefix(1)', parensStripped: true, lossy: false },
      { raw: 'light of the jedi', tag: 'suffix(1)', parensStripped: true, lossy: false },
    ]);
  });

  it('echoes the TRIMMED title as input', async () => {
    const res = await post({ title: '  Chapterhouse: Dune  ' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.input).toBe('Chapterhouse: Dune');
    expect(body.full).toBe('chapterhouse dune');
  });

  it('returns 200 with variants: [] and full: "" for a title that yields no variants', async () => {
    const res = await post({ title: '[ ]' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(true);
    expect(body.full).toBe('');
    expect(body.lossless).toBe('');
    expect(body.degenerateFull).toBe(false);
    expect(body.variants).toEqual([]);
  });

  // In the motivating case, equal full forms differ because one is degenerate; expose lossless.
  it('surfaces the degeneracy inputs for a title whose subtitle the fold erases', async () => {
    const res = await post({ title: 'World of Warcraft: Перед бурей' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(true);
    expect(body.full).toBe('world of warcraft');
    expect(body.lossless).toBe('world of warcraft перед бурей');
    expect(body.degenerateFull).toBe(true);
    expect(body.variants).toEqual([
      { raw: 'world of warcraft', tag: 'full', parensStripped: false, lossy: true },
    ]);
  });

  // Assert raw keys directly because non-strict Zod parsing would hide extras.
  it('returns exactly the five per-side keys when `other` is omitted', async () => {
    const body = JSON.parse((await post({ title: 'Chapterhouse: Dune' })).payload);
    expect(Object.keys(body).sort()).toEqual(['degenerateFull', 'full', 'input', 'lossless', 'variants']);
  });

  describe('two-title comparison (#2110)', () => {
    const wowComparison = {
      input: 'World of Warcraft: Перед бурей',
      full: 'world of warcraft',
      lossless: 'world of warcraft перед бурей',
      degenerateFull: true,
      variants: [{ raw: 'world of warcraft', tag: 'full', parensStripped: false, lossy: true }],
      comparison: {
        pairs: false,
        arm: 'none',
        other: {
          input: 'World of Warcraft: Beyond the Dark Portal',
          full: 'world of warcraft beyond the dark portal',
          lossless: 'world of warcraft beyond the dark portal',
          degenerateFull: false,
          variants: [
            { raw: 'world of warcraft beyond the dark portal', tag: 'full', parensStripped: false, lossy: false },
            { raw: 'world of warcraft', tag: 'prefix(1)', parensStripped: true, lossy: false },
            { raw: 'beyond the dark portal', tag: 'suffix(1)', parensStripped: true, lossy: false },
          ],
        },
      },
    };

    // Assert reason content separately so its prose remains free to change.
    it('returns the whole worked example for the motivating pair', async () => {
      const res = await post({
        title: 'World of Warcraft: Перед бурей',
        other: 'World of Warcraft: Beyond the Dark Portal',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(true);

      const { reason, ...comparisonWithoutReason } = body.comparison;
      expect({ ...body, comparison: comparisonWithoutReason }).toEqual(wowComparison);

      expect(reason).toContain('world of warcraft');
      expect(reason).toContain('world of warcraft beyond the dark portal');
    });

    it.each([
      ['title', { title: 'The Churn: An Expanse Novella', other: 'The Churn' }],
      ['other', { title: 'The Churn', other: 'The Churn: An Expanse Novella' }],
    ])('reports derived-equals-full with the offering side named as %s', async (offeringSide, payload) => {
      const body = JSON.parse((await post(payload)).payload);

      expect(body.comparison.pairs).toBe(true);
      expect(body.comparison.arm).toBe('derived-equals-full');
      expect(body.comparison.reason).toContain('prefix(1)');
      expect(body.comparison.reason).toContain('the churn');
      expect(body.comparison.reason).toContain(`(offered by: ${offeringSide})`);
    });

    it('reports full-equals-full for two spellings of the same title', async () => {
      const body = JSON.parse((await post({ title: 'Chapterhouse: Dune', other: 'Chapterhouse Dune' })).payload);
      expect(body.comparison).toMatchObject({ pairs: true, arm: 'full-equals-full' });
      expect(body.comparison.reason).toContain('chapterhouse dune');
    });

    it('reports lossless-equals-lossless for identical non-Latin twins', async () => {
      const body = JSON.parse((await post({ title: 'Перед бурей', other: '  перед  БУРЕЙ (Unabridged)' })).payload);
      expect(body.comparison).toMatchObject({ pairs: true, arm: 'lossless-equals-lossless' });
      // The arm keys on lossless text even though both folded forms are empty.
      expect(body.comparison.reason).toContain('(empty)');
      expect(body.comparison.reason).toContain('перед бурей');
      expect(body.full).toBe('');
      expect(body.variants).toEqual([]);
    });

    it('delegates the verdict to the exported explainTitlePairing', async () => {
      const spy = vi.mocked(explainTitlePairing);
      spy.mockClear();

      const body = JSON.parse((await post({ title: 'Chapterhouse: Dune', other: 'Chapterhouse Dune' })).payload);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('Chapterhouse: Dune', 'Chapterhouse Dune');
      expect(body.comparison).toMatchObject(spy.mock.results[0]!.value);
    });

    it('does not call the pairing rule at all when `other` is omitted', async () => {
      const spy = vi.mocked(explainTitlePairing);
      spy.mockClear();
      await post({ title: 'Chapterhouse: Dune' });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['missing title', {}],
    ['empty string', { title: '' }],
    ['whitespace only', { title: '   ' }],
    ['over 1024 characters', { title: 'x'.repeat(1025) }],
    ['whitespace-only other', { title: 'Chapterhouse: Dune', other: '   ' }],
    ['empty other', { title: 'Chapterhouse: Dune', other: '' }],
    ['over-1024 other', { title: 'Chapterhouse: Dune', other: 'x'.repeat(1025) }],
  ])('returns 400 for %s', async (_label, payload) => {
    expect((await post(payload)).statusCode).toBe(400);
  });

  it('accepts a title at exactly the 1024-character bound', async () => {
    expect((await post({ title: 'x'.repeat(1024) })).statusCode).toBe(200);
  });

  it('accepts an `other` at exactly the 1024-character bound', async () => {
    expect((await post({ title: 'Chapterhouse: Dune', other: 'x'.repeat(1024) })).statusCode).toBe(200);
  });
});
