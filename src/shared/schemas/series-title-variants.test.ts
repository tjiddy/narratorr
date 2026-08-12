import { describe, it, expect } from 'vitest';
import {
  variantTagSchema,
  variantSchema,
  titleVariantsDebugBodySchema,
  titleVariantsDebugResponseSchema,
  type Variant,
  type VariantTag,
} from './series-title-variants.js';
// Tests may cross the shared-to-core boundary to detect public type drift.
import type {
  Variant as CoreVariant,
  VariantTag as CoreVariantTag,
} from '@core/utils/title-variants.js';

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('variantTagSchema (#2096)', () => {
  it.each([['full'], ['first+last'], ['prefix(2)'], ['suffix(11)'], ['prefix(0)']])(
    'accepts %j',
    (tag) => {
      expect(variantTagSchema.safeParse(tag).success).toBe(true);
    },
  );

  it.each([['prefix()'], ['prefix(x)'], ['middle(1)'], ['prefix( 2 )'], ['Full'], ['prefix(2) ']])(
    'rejects %j',
    (tag) => {
      expect(variantTagSchema.safeParse(tag).success).toBe(false);
    },
  );

  it.each([['prefix(1.5)'], ['prefix(-2)']])('accepts %j — the declared `${number}` domain', (tag) => {
    expect(variantTagSchema.safeParse(tag).success).toBe(true);
  });
});

describe('variantSchema (#2096)', () => {
  it('parses a well-formed variant', () => {
    const parsed = variantSchema.safeParse({ raw: 'star wars', tag: 'prefix(1)', parensStripped: true, lossy: false });
    expect(parsed.success).toBe(true);
  });

  it('rejects a variant carrying an unknown tag', () => {
    expect(
      variantSchema.safeParse({ raw: 'x', tag: 'middle(1)', parensStripped: true, lossy: false }).success,
    ).toBe(false);
  });

  it('rejects a variant missing parensStripped', () => {
    expect(variantSchema.safeParse({ raw: 'x', tag: 'full', lossy: false }).success).toBe(false);
  });

  it('rejects a variant missing lossy', () => {
    expect(variantSchema.safeParse({ raw: 'x', tag: 'full', parensStripped: false }).success).toBe(false);
  });
});

describe('titleVariantsDebug schemas (#2096)', () => {
  it('trims the request title and enforces the 1-1024 bound', () => {
    const parsed = titleVariantsDebugBodySchema.safeParse({ title: '  Chapterhouse: Dune  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.title).toBe('Chapterhouse: Dune');
    expect(titleVariantsDebugBodySchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: '' }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({}).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'x'.repeat(1025) }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'x'.repeat(1024) }).success).toBe(true);
  });

  it('accepts an absent `other` and applies the same bounds when present', () => {
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'Chapterhouse: Dune' }).success).toBe(true);
    const parsed = titleVariantsDebugBodySchema.safeParse({ title: 'a', other: '  Chapterhouse Dune  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.other).toBe('Chapterhouse Dune');
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'a', other: '   ' }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'a', other: '' }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'a', other: 'x'.repeat(1025) }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'a', other: 'x'.repeat(1024) }).success).toBe(true);
  });

  it('composes variantSchema into the response envelope', () => {
    const parsed = titleVariantsDebugResponseSchema.safeParse({
      input: 'Foo: Subtitle',
      full: 'foo subtitle',
      lossless: 'foo subtitle',
      degenerateFull: false,
      variants: [{ raw: 'foo subtitle', tag: 'full', parensStripped: false, lossy: false }],
    });
    expect(parsed.success).toBe(true);
    expect(
      titleVariantsDebugResponseSchema.safeParse({
        input: 'x',
        full: '',
        lossless: '',
        degenerateFull: false,
        variants: [{ raw: 'x', tag: 'nope', parensStripped: false, lossy: false }],
      }).success,
    ).toBe(false);
  });

  it('accepts the zero-variant arm', () => {
    expect(
      titleVariantsDebugResponseSchema.safeParse({
        input: '[ ]',
        full: '',
        lossless: '',
        degenerateFull: false,
        variants: [],
      }).success,
    ).toBe(true);
  });
});

describe('two-title comparison envelope (#2110)', () => {
  const side = (input: string, full: string, lossless: string, degenerateFull: boolean) => ({
    input,
    full,
    lossless,
    degenerateFull,
    variants: [{ raw: full, tag: 'full' as const, parensStripped: false, lossy: degenerateFull }],
  });

  const twoTitleResponse = {
    ...side('World of Warcraft: Перед бурей', 'world of warcraft', 'world of warcraft перед бурей', true),
    comparison: {
      pairs: false,
      arm: 'none',
      reason: 'no arm applies',
      other: side(
        'World of Warcraft: Beyond the Dark Portal',
        'world of warcraft beyond the dark portal',
        'world of warcraft beyond the dark portal',
        false,
      ),
    },
  };

  it('parses a full two-title response', () => {
    expect(titleVariantsDebugResponseSchema.safeParse(twoTitleResponse).success).toBe(true);
  });

  it.each([['full-equals-full'], ['derived-equals-full'], ['lossless-equals-lossless'], ['none']])(
    'accepts arm %j',
    (arm) => {
      const body = { ...twoTitleResponse, comparison: { ...twoTitleResponse.comparison, arm } };
      expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(true);
    },
  );

  it('rejects an unknown arm literal', () => {
    const body = { ...twoTitleResponse, comparison: { ...twoTitleResponse.comparison, arm: 'derived-equals-derived' } };
    expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a comparison missing `other`', () => {
    const { other: _other, ...withoutOther } = twoTitleResponse.comparison;
    expect(
      titleVariantsDebugResponseSchema.safeParse({ ...twoTitleResponse, comparison: withoutOther }).success,
    ).toBe(false);
  });

  it('rejects an empty reason', () => {
    const body = { ...twoTitleResponse, comparison: { ...twoTitleResponse.comparison, reason: '' } };
    expect(titleVariantsDebugResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects an explicitly null comparison', () => {
    const { comparison: _comparison, ...singleTitle } = twoTitleResponse;
    expect(titleVariantsDebugResponseSchema.safeParse(singleTitle).success).toBe(true);
    expect(titleVariantsDebugResponseSchema.safeParse({ ...singleTitle, comparison: null }).success).toBe(false);
  });
});

describe('core ↔ shared type-contract drift guards (#2096)', () => {
  // Guard both: Variant.tag resolves through the shared type, so Variant equality
  // alone cannot detect a hand-written core VariantTag.
  it('core Variant is still the shared Variant', () => {
    const aligned: Equals<Variant, CoreVariant> = true;
    expect(aligned).toBe(true);
  });

  it('core VariantTag is still the shared VariantTag', () => {
    const aligned: Equals<VariantTag, CoreVariantTag> = true;
    expect(aligned).toBe(true);
  });
});
